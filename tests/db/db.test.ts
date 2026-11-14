import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, ORCHESTRATOR_PROMPT, PresetService } from '../../src/main/domain/preset'
import { migrate, openDatabase, ORCHESTRATOR_PROMPT_V1, type Db } from '../../src/main/infrastructure/db/database'
import { SqlitePresetRepo } from '../../src/main/infrastructure/db/presets'

let dir: string
let file: string
let db: Db
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-canvas-db-'))
  file = join(dir, 'test.db')
  db = openDatabase(file)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Back to what version 2 had: no F8 tables. */
function dropF8(d: Db): void {
  for (const t of ['loops', 'web_tiles', 'squad_extras', 'squad_groups', 'squads', 'edges', 'nodes', 'groups', 'agents', 'workspaces', 'projects', 'memory', 'annotations', 'settings']) d.exec(`DROP TABLE IF EXISTS ${t}`)
}

const base = { name: 'Mine', role: 'mine', adapter: 'claude' as const, model: null, systemPrompt: '', builtin: false, createdAt: 1 }

describe('database', () => {
  it('migrates an empty file, is idempotent, and seeds the built-ins once', () => {
    const names = () => new SqlitePresetRepo(db).list().map((p) => p.name)
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    expect(names()).toEqual(BUILTIN_PRESETS.map((b) => b.name))
    migrate(db)
    migrate(db)
    expect(names()).toHaveLength(5)
    db.close()
    db = openDatabase(file) // reopen
    expect(names()).toHaveLength(5)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })
  it('seeds built-ins with claude, default model and a prompt', () => {
    for (const p of new SqlitePresetRepo(db).list()) expect(p).toMatchObject({ adapter: 'claude', model: null, builtin: true })
    expect(new SqlitePresetRepo(db).list().every((p) => p.systemPrompt.length > 0)).toBe(true)
  })
  it('version 2 teaches the built-in Orchestrator its tools; an edited prompt and user presets are left alone', () => {
    const r = new SqlitePresetRepo(db)
    const orch = () => r.list().find((p) => p.builtin && p.role === 'orchestrator')!
    expect(orch().systemPrompt).toBe(ORCHESTRATOR_PROMPT) // a new database gets it directly
    for (const tool of ['list_agents', 'send_message', 'read_last_message', 'spawn_agent', 'report_status']) expect(ORCHESTRATOR_PROMPT).toContain(tool)
    // a database as version 1 left it, with a user preset that copied the old text
    db.prepare('UPDATE presets SET system_prompt = ? WHERE id = ?').run(ORCHESTRATOR_PROMPT_V1, orch().id)
    r.insert({ ...base, id: 'u', name: 'My lead', role: 'orchestrator', systemPrompt: ORCHESTRATOR_PROMPT_V1 })
    db.pragma('user_version = 1')
    dropF8(db)
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    expect(orch().systemPrompt).toBe(ORCHESTRATOR_PROMPT)
    expect(r.get('u')!.systemPrompt).toBe(ORCHESTRATOR_PROMPT_V1)
    // the user had changed the built-in prompt: kept
    db.prepare('UPDATE presets SET system_prompt = ? WHERE id = ?').run('my own words', orch().id)
    db.pragma('user_version = 1')
    dropF8(db)
    migrate(db)
    expect(orch().systemPrompt).toBe('my own words')
    expect(r.list().filter((p) => p.builtin).map((p) => p.systemPrompt)).toEqual([...BUILTIN_PRESETS.slice(0, 4).map((p) => p.systemPrompt), 'my own words'])
  })
  it('refuses a database from a newer app', () => {
    const other = new Database(join(dir, 'new.db'))
    other.pragma('user_version = 99')
    expect(() => migrate(other)).toThrow('newer')
    other.close()
  })
  it('creates the file with mode 0600 (and the wal files too) in a 0700 directory', () => {
    new SqlitePresetRepo(db).insert({ ...base, id: 'x' })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    for (const ext of ['-wal', '-shm']) expect(statSync(file + ext).mode & 0o777).toBe(0o600)
  })
})

describe('SqlitePresetRepo', () => {
  it('creates, updates and deletes', () => {
    const r = new SqlitePresetRepo(db)
    r.insert({ ...base, id: 'x' })
    expect(r.get('x')).toEqual({ ...base, id: 'x' })
    r.update({ ...base, id: 'x', name: 'Renamed', role: 'r2', model: 'opus', systemPrompt: 'hi' })
    expect(r.get('x')).toMatchObject({ name: 'Renamed', role: 'r2', model: 'opus', systemPrompt: 'hi', builtin: false })
    expect(r.delete('x')).toBe(true)
    expect(r.get('x')).toBeUndefined()
    expect(r.delete('x')).toBe(false)
  })
  it('refuses to delete a built-in', () => {
    const r = new SqlitePresetRepo(db)
    const b = r.list()[0]!
    expect(r.delete(b.id)).toBe(false)
    expect(r.get(b.id)).toBeDefined()
  })
  it('enforces unique names case-insensitively', () => {
    const r = new SqlitePresetRepo(db)
    expect(() => r.insert({ ...base, id: 'x', name: 'FRONTEND' })).toThrow(/UNIQUE/)
    r.insert({ ...base, id: 'y', name: 'Mine' })
    expect(() => r.insert({ ...base, id: 'z', name: 'mine' })).toThrow(/UNIQUE/)
  })
  it('stores quotes, semicolons and SQL keywords verbatim', () => {
    const r = new SqlitePresetRepo(db)
    const nasty = `Robert'); DROP TABLE presets;-- "q" \\ ; SELECT * FROM presets WHERE 1=1 -- é\u{1F600}`
    r.insert({ ...base, id: "x'; DROP TABLE presets;--", name: nasty, systemPrompt: nasty })
    const back = r.get("x'; DROP TABLE presets;--")
    expect(back?.name).toBe(nasty)
    expect(back?.systemPrompt).toBe(nasty)
    expect(r.list()).toHaveLength(6)
    r.update({ ...back!, systemPrompt: `'; DELETE FROM presets; --` })
    expect(r.list()).toHaveLength(6)
    expect(r.get(back!.id)?.systemPrompt).toBe(`'; DELETE FROM presets; --`)
  })
  it('works through PresetService end to end', () => {
    let n = 0
    const s = new PresetService(new SqlitePresetRepo(db), () => `id${++n}`)
    const p = s.save({ name: 'Docs', role: 'docs', model: 'haiku', systemPrompt: 'write docs' })
    expect(s.list().map((x) => x.name)).toContain('Docs')
    expect(() => s.save({ name: 'docs', role: 'docs2', model: null, systemPrompt: '' })).toThrow('already exists')
    s.delete(p.id)
    expect(() => s.delete(s.list()[0]!.id)).toThrow('Built-in')
  })
})

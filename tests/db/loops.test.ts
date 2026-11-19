import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SavedLoop } from '../../src/main/domain/loop'
import { openDatabase, type Db } from '../../src/main/infrastructure/db/database'
import { SqliteLoopRepo } from '../../src/main/infrastructure/db/loops'

let dir: string
let db: Db
let repo: SqliteLoopRepo
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodshell-loops-'))
  db = openDatabase(join(dir, 'test.db'))
  repo = new SqliteLoopRepo(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const A = '/home/u/repo a'
const B = '/home/u/repo b'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const idle: SavedLoop = { id: id(1), workspaceId: id(9), agentId: id(11), prompt: 'run the tests\nand report', trigger: { kind: 'idle', afterSec: 30 }, goal: 'all green', maxRuns: 20 }
const every: SavedLoop = { id: id(2), workspaceId: id(9), agentId: id(12), prompt: "x'); DROP TABLE loops;--", trigger: { kind: 'schedule', everySec: 3600 }, goal: '', maxRuns: 1 }
const watch: SavedLoop = { id: id(3), workspaceId: id(9), agentId: id(13), prompt: 'fix it', trigger: { kind: 'output', terminalId: id(14), text: 'FAILED' }, goal: '', maxRuns: 100 }

describe('loops repo', () => {
  it('the migration (version 6) creates the table', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(8)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'loops'").all()).toHaveLength(1)
  })
  it('round-trips every kind of trigger, in order, and a save replaces the list', () => {
    repo.replace(A, [watch, idle, every])
    repo.replace(B, [idle])
    expect(repo.load(A)).toEqual([watch, idle, every])
    repo.replace(A, [every])
    expect(repo.load(A)).toEqual([every])
    expect(repo.load(B)).toEqual([idle])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'loops'").all()).toHaveLength(1)
  })
  it('a row that does not make a trigger is left out; the check constraint refuses an unknown kind', () => {
    repo.replace(A, [idle])
    db.prepare("INSERT INTO loops (project, id, workspace_id, agent_id, prompt, trigger_kind, trigger_sec, terminal_id, trigger_text, goal, max_runs, ord) VALUES (?, ?, ?, ?, 'p', 'output', NULL, NULL, NULL, '', 1, 1)").run(A, id(5), id(9), id(15))
    expect(repo.load(A)).toEqual([idle])
    expect(() => db.prepare("INSERT INTO loops (project, id, workspace_id, agent_id, prompt, trigger_kind, goal, max_runs, ord) VALUES (?, ?, ?, ?, 'p', 'cron', '', 1, 2)").run(A, id(6), id(9), id(16))).toThrow(/CHECK/)
  })
  it('clear empties one project only; deleting the project takes its loops', () => {
    repo.replace(A, [idle, every])
    repo.replace(B, [watch])
    repo.clear(A)
    expect(repo.load(A)).toEqual([])
    expect(repo.load(B)).toEqual([watch])
    db.prepare('DELETE FROM projects WHERE root = ?').run(B)
    expect(repo.load(B)).toEqual([])
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryService } from '../../src/main/application/memory'
import type { SavedBoard } from '../../src/main/domain/board'
import { openDatabase, type Db } from '../../src/main/infrastructure/db/database'
import { SqliteBoardRepo } from '../../src/main/infrastructure/db/board'
import { SqliteMemoryRepo } from '../../src/main/infrastructure/db/memory'
import { SqlitePresetRepo } from '../../src/main/infrastructure/db/presets'
import { MEMORY_MAX } from '../../src/shared/memory'

let dir: string
let db: Db
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodshell-board-'))
  db = openDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const ROOT = '/home/u/my repo'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W1 = id(1), W2 = id(2)
const ORCH = id(10), F1 = id(11), F2 = id(12), B1 = id(13), CON = id(14), LOOSE = id(15)
const GF = id(20), GB = id(21), GC = id(22), SQ = id(30)
const agent = (aid: string, role: string, name: string, n: number) => ({ id: aid, role, presetId: id(90), model: role === 'orchestrator' ? null : 'sonnet', name, systemPrompt: `be a ${role}; "quotes" '; DROP TABLE agents;--`, branch: `agent/${role}-${n}`, worktree: `/data/worktrees/abc/${role}-${n}`, base: 'a'.repeat(40), sessionId: id(100 + n), pending: role === 'qa' })

/** Two workspaces: a squad (Orchestrator, Frontend, Backend) with an extra, a loose group of a console and an agent, edges with template and condition. */
function fullBoard(): SavedBoard {
  return {
    workspaces: [
      { id: W1, name: 'Workspace 1', order: 0, viewport: { x: -120.5, y: 40, zoom: 0.8 }, active: false },
      { id: W2, name: 'Workspace 2', order: 1, viewport: { x: 0, y: 0, zoom: 1 }, active: true },
    ],
    nodes: [
      { id: SQ, kind: 'orchestrator', workspaceId: W1, x: 900, y: 140, w: 300, h: 700, pinned: false, parentId: null, order: 0 },
      { id: ORCH, kind: 'agent', workspaceId: W1, x: 0, y: 0, w: 420, h: 280, pinned: false, parentId: SQ, order: 0 },
      { id: GF, kind: 'group', workspaceId: W1, x: 24, y: 140, w: 876, h: 304, pinned: false, parentId: null, order: 0 },
      { id: F1, kind: 'agent', workspaceId: W1, x: 12, y: 12, w: 420, h: 280, pinned: false, parentId: GF, order: 0 },
      { id: F2, kind: 'agent', workspaceId: W1, x: 444, y: 12, w: 420, h: 280, pinned: false, parentId: GF, order: 1 },
      { id: GB, kind: 'group', workspaceId: W1, x: 1320, y: 140, w: 444, h: 304, pinned: false, parentId: null, order: 0 },
      { id: B1, kind: 'agent', workspaceId: W1, x: 12, y: 12, w: 420, h: 280, pinned: false, parentId: GB, order: 0 },
      { id: GC, kind: 'group', workspaceId: W2, x: 10, y: 20, w: 876, h: 304, pinned: false, parentId: null, order: 0 },
      { id: CON, kind: 'console', workspaceId: W2, x: 12, y: 12, w: 420, h: 280, pinned: false, parentId: GC, order: 0 },
      { id: LOOSE, kind: 'agent', workspaceId: W2, x: 444, y: 12, w: 420, h: 280, pinned: true, parentId: GC, order: 1 },
    ],
    agents: [agent(ORCH, 'orchestrator', 'Max', 1), agent(F1, 'frontend', 'Zoe', 1), agent(F2, 'frontend', 'Leo', 2), agent(B1, 'backend', 'Pip', 1), agent(LOOSE, 'qa', 'Ada', 1)],
    groups: [
      { id: GF, name: 'Frontend', collapsed: false, presetId: null },
      { id: GB, name: 'Backend', collapsed: true, presetId: null },
      { id: GC, name: 'Mixed', collapsed: false, presetId: id(91) },
    ],
    squads: [{ id: SQ, orchestratorId: ORCH, groupIds: [GF, GB], extraIds: [B1] }],
    edges: [
      { id: id(40), workspaceId: W1, source: { kind: 'group', id: GF }, target: { kind: 'squad', id: SQ }, template: 'From {name}:\n{message}', condition: '', paused: null },
      { id: id(41), workspaceId: W1, source: { kind: 'agent', id: F1 }, target: { kind: 'agent', id: B1 }, template: 'Review: {message}', condition: 'DONE', paused: 'Paused by you' },
    ],
  }
}

describe('SqliteBoardRepo', () => {
  it('saves and loads a complete board, per project', () => {
    const r = new SqliteBoardRepo(db)
    expect(r.load(ROOT)).toBeNull()
    r.save(ROOT, fullBoard())
    expect(r.load(ROOT)).toEqual(fullBoard())
    expect(r.load('/other')).toBeNull()
    // a second save replaces the board (no leftovers)
    const smaller = fullBoard()
    smaller.edges = []
    smaller.squads = []
    r.save(ROOT, smaller)
    expect(r.load(ROOT)).toEqual(smaller)
  })

  it('keeps boards of two projects apart; clear empties one board; deleting a project cascades everything of it', () => {
    const r = new SqliteBoardRepo(db)
    r.save(ROOT, fullBoard())
    const other = fullBoard()
    // ids are unique across the database: the other project gets its own
    const re = (s: string) => s.replace(/^00000000/, '11111111')
    const json = JSON.stringify(other).replace(/00000000-0000-4000-8000-\d{12}/g, re)
    r.save('/other', JSON.parse(json) as SavedBoard)
    r.clear(ROOT)
    expect(r.load(ROOT)).toBeNull()
    expect(r.load('/other')).not.toBeNull()
    r.save(ROOT, fullBoard())
    db.prepare('DELETE FROM projects WHERE root = ?').run(ROOT) // the foreign keys cascade
    for (const t of ['workspaces', 'nodes', 'agents', 'groups', 'squads', 'squad_groups', 'squad_extras', 'edges']) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      expect(n, t).toBeGreaterThan(0) // only the other project's rows are left
    }
    expect(r.load(ROOT)).toBeNull()
    db.prepare('DELETE FROM projects WHERE root = ?').run('/other')
    for (const t of ['workspaces', 'nodes', 'agents', 'groups', 'squads', 'squad_groups', 'squad_extras', 'edges', 'projects']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0)
  })

  it('remembers the last project opened', () => {
    const r = new SqliteBoardRepo(db)
    expect(r.lastProject()).toBeNull()
    r.touch('/a')
    r.touch('/b')
    expect(r.lastProject()).toBe('/b')
    r.touch('/a')
    expect(r.lastProject()).toBe('/a')
    r.save('/b', fullBoard()) // saving never makes a project the last one
    expect(r.lastProject()).toBe('/a')
  })

  it('a broken reference rolls the whole save back (one transaction, foreign keys on)', () => {
    const r = new SqliteBoardRepo(db)
    r.save(ROOT, fullBoard())
    const bad = fullBoard()
    bad.squads = [{ id: SQ, orchestratorId: id(999), groupIds: [], extraIds: [] }]
    expect(() => r.save(ROOT, bad)).toThrow(/FOREIGN KEY/)
    expect(r.load(ROOT)).toEqual(fullBoard())
  })

  it('leaves presets alone', () => {
    new SqliteBoardRepo(db).save(ROOT, fullBoard())
    expect(new SqlitePresetRepo(db).list()).toHaveLength(5)
  })
})

describe('memory', () => {
  it('global and per repository, with who wrote it last; append respects the limit', () => {
    let t = 1000
    const m = new MemoryService(new SqliteMemoryRepo(db), () => t++)
    expect(m.read('global', null)).toEqual({ content: '', updatedAt: null, updatedBy: null })
    expect(() => m.read('repo', null)).toThrow('Open a repository first')
    expect(m.write('global', null, '# Notes\r\nuse pnpm\u0007\tok', 'you')).toEqual({ content: '# Notes\nuse pnpm\tok', updatedAt: 1000, updatedBy: 'you' })
    m.write('repo', ROOT, 'repo rule', 'Zoe')
    expect(m.read('repo', '/other').content).toBe('')
    expect(m.write('repo', ROOT, 'second', 'Leo', 'append')).toEqual({ content: 'repo rule\nsecond', updatedAt: 1002, updatedBy: 'Leo' })
    expect(m.read('repo', ROOT)).toEqual({ content: 'repo rule\nsecond', updatedAt: 1002, updatedBy: 'Leo' })
    expect(m.read('global', null).content).toBe('# Notes\nuse pnpm\tok')
    // limits in bytes: a multibyte text counts each byte
    expect(() => m.write('global', null, 'é'.repeat(MEMORY_MAX / 2 + 1), 'you')).toThrow('64 KiB')
    m.write('global', null, 'x'.repeat(MEMORY_MAX - 2), 'you')
    expect(() => m.write('global', null, 'yy', 'Zoe', 'append')).toThrow('64 KiB') // + the line break
    m.write('global', null, 'y', 'Zoe', 'append')
    expect(m.read('global', null)).toMatchObject({ updatedBy: 'Zoe' })
    expect(new TextEncoder().encode(m.read('global', null).content).length).toBe(MEMORY_MAX)
  })
})

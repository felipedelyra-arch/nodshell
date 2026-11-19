import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/infrastructure/db/database'
import { SqliteWebTileRepo, type SavedTile } from '../../src/main/infrastructure/db/webtiles'

let dir: string
let db: Db
let repo: SqliteWebTileRepo
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodshell-tiles-'))
  db = openDatabase(join(dir, 'test.db'))
  repo = new SqliteWebTileRepo(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const A = '/home/u/repo a'
const B = '/home/u/repo b'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const t1: SavedTile = { id: id(1), workspaceId: id(9), url: 'http://localhost:3000/', x: 10.5, y: -20, w: 480, h: 330, pageWidth: 768 }
const t2: SavedTile = { id: id(2), workspaceId: id(9), url: "https://example.com/a?q='; DROP TABLE web_tiles;--", x: 0, y: 0, w: 0, h: 0, pageWidth: null }

describe('web tiles repo', () => {
  it('the migration (version 5) creates the table; the schema is now at version 8', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(8)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'web_tiles'").all()).toHaveLength(1)
  })
  it('round-trips the tiles of a project, in order, and a save replaces the list', () => {
    repo.replace(A, [t2, t1])
    repo.replace(B, [t1])
    expect(repo.load(A)).toEqual([t2, t1])
    repo.replace(A, [t1])
    expect(repo.load(A)).toEqual([t1])
    expect(repo.load(B)).toEqual([t1])
  })
  it('a row saved before the viewport preset existed loads as Fit, and a value that is not a preset is Fit too', () => {
    db.prepare('INSERT INTO projects (root, opened_at) VALUES (?, 0)').run(A)
    const ins = db.prepare('INSERT INTO web_tiles (project, id, workspace_id, url, x, y, w, h, ord) VALUES (?, ?, ?, ?, 0, 0, 1, 1, ?)')
    ins.run(A, id(1), id(9), 'http://localhost/', 0)
    ins.run(A, id(2), id(9), 'http://localhost/', 1)
    db.prepare('UPDATE web_tiles SET page_width = 555 WHERE id = ?').run(id(2))
    expect(repo.load(A).map((r) => r.pageWidth)).toEqual([null, null])
  })
  it('clear empties one project only; deleting the project takes its tiles', () => {
    repo.replace(A, [t1, t2])
    repo.replace(B, [t2])
    repo.clear(A)
    expect(repo.load(A)).toEqual([])
    expect(repo.load(B)).toEqual([t2])
    db.prepare('DELETE FROM projects WHERE root = ?').run(B)
    expect(repo.load(B)).toEqual([])
  })
})

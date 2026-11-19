import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANNOTATIONS_MAX, type Annotation } from '../../src/shared/annotation'
import { SqliteAnnotationRepo } from '../../src/main/infrastructure/db/annotations'
import { SqliteBoardRepo } from '../../src/main/infrastructure/db/board'
import { openDatabase, type Db } from '../../src/main/infrastructure/db/database'
import { emptyBoard } from '../../src/main/domain/board'

let dir: string
let db: Db
let repo: SqliteAnnotationRepo
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodshell-ann-'))
  db = openDatabase(join(dir, 'test.db'))
  repo = new SqliteAnnotationRepo(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const A = '/home/u/repo a'
const B = '/home/u/repo b'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W1 = id(1), W2 = id(2)
const stroke: Annotation = { id: id(10), kind: 'stroke', color: '#ff6a2b', width: 3, points: [[0, 0], [12.5, -4], [30, 8]] }
const shape: Annotation = { id: id(11), kind: 'shape', shape: 'ellipse', color: '#3ddc84', x: -50, y: 20, w: 120, h: 80 }
const note: Annotation = { id: id(12), kind: 'text', color: '#e4e4e7', x: 5, y: 5, w: 240, h: 96, text: `line one\nline "two" '; DROP TABLE annotations;-- <script>` }
const image: Annotation = { id: id(13), kind: 'image', imageId: id(99), x: 0, y: 0, w: 300, h: 200 }
const count = () => (db.prepare('SELECT COUNT(*) AS n FROM annotations').get() as { n: number }).n

describe('annotations repo', () => {
  it('the migration (version 4) creates the table; the schema is now at version 6', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(8)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'annotations'").all()).toHaveLength(1)
  })
  it('round-trips every kind, in order, per workspace', () => {
    repo.replace(A, W1, [stroke, shape, note, image])
    repo.replace(A, W2, [shape])
    const back = repo.load(A)
    expect(back.get(W1)).toEqual([stroke, shape, note, image])
    expect(back.get(W2)).toEqual([shape])
    expect(repo.load(B).size).toBe(0)
  })
  it('a save replaces one workspace and leaves the others', () => {
    repo.replace(A, W1, [stroke, shape])
    repo.replace(A, W2, [note])
    repo.replace(A, W1, [shape])
    expect(repo.load(A).get(W1)).toEqual([shape])
    expect(repo.load(A).get(W2)).toEqual([note])
    repo.replace(A, W1, [])
    expect(repo.load(A).has(W1)).toBe(false)
  })
  it('the same ids can live in two projects', () => {
    repo.replace(A, W1, [shape])
    repo.replace(B, W1, [shape])
    expect(count()).toBe(2)
  })
  it('goes with its project (cascade) and not with a board save, which recreates the workspaces', () => {
    repo.replace(A, W1, [stroke, image])
    repo.replace(B, W1, [shape])
    new SqliteBoardRepo(db).save(A, { ...emptyBoard(), workspaces: [{ id: W1, name: 'Workspace 1', order: 0, viewport: { x: 0, y: 0, zoom: 1 }, active: true }] })
    new SqliteBoardRepo(db).clear(A)
    expect(repo.load(A).get(W1)).toEqual([stroke, image])
    db.prepare('DELETE FROM projects WHERE root = ?').run(A)
    expect(repo.load(A).size).toBe(0)
    expect(repo.load(B).get(W1)).toEqual([shape])
  })
  it('drops what does not validate on the way out and keeps the rest', () => {
    repo.replace(A, W1, [stroke, shape, note])
    const set = db.prepare('UPDATE annotations SET data = ? WHERE id = ?')
    set.run(JSON.stringify({ ...shape, x: 'NaN' }), shape.id) // wrong type
    db.prepare("INSERT INTO annotations (project, workspace_id, id, kind, image_id, data, ord) VALUES (?, ?, ?, 'text', NULL, ?, 9)").run(A, W1, id(20), '{not json')
    db.prepare("INSERT INTO annotations (project, workspace_id, id, kind, image_id, data, ord) VALUES (?, ?, ?, 'text', NULL, ?, 10)").run(A, W1, id(21), JSON.stringify({ ...note, id: id(21), text: 'x'.repeat(5000) }))
    db.prepare("INSERT INTO annotations (project, workspace_id, id, kind, image_id, data, ord) VALUES (?, ?, ?, 'shape', NULL, ?, 11)").run(A, W1, id(22), JSON.stringify({ ...shape, id: id(99) })) // id differs from its row
    expect(repo.load(A).get(W1)).toEqual([stroke, note])
  })
  it('never loads more than the ceiling per workspace', () => {
    const ins = db.prepare("INSERT INTO annotations (project, workspace_id, id, kind, image_id, data, ord) VALUES (?, ?, ?, 'shape', NULL, ?, ?)")
    repo.replace(A, W1, [])
    db.transaction(() => {
      for (let i = 0; i < ANNOTATIONS_MAX + 50; i++) ins.run(A, W1, id(1000 + i), JSON.stringify({ ...shape, id: id(1000 + i) }), i)
    })()
    expect(repo.load(A).get(W1)).toHaveLength(ANNOTATIONS_MAX)
  })
  it('prune deletes only the named workspaces and returns their images', () => {
    repo.replace(A, W1, [image])
    repo.replace(A, W2, [{ ...image, id: id(14), imageId: id(98) }, shape])
    expect(repo.prune(A, [W2, id(77)])).toEqual([id(98)])
    expect([...repo.load(A).keys()]).toEqual([W1])
    expect(repo.prune(A, [W2])).toEqual([])
  })
  it('replace returns the images the workspace no longer has; projectImageIds lists the project\'s own', () => {
    repo.replace(A, W1, [image, { ...image, id: id(14), imageId: id(98) }])
    expect(repo.replace(A, W1, [image])).toEqual([id(98)])
    expect([...repo.projectImageIds(A)]).toEqual([id(99)])
    expect(repo.projectImageIds(B).size).toBe(0)
  })
  it('clear empties one project and returns its images; imageIds lists what any project uses', () => {
    repo.replace(A, W1, [image, stroke])
    repo.replace(B, W1, [{ ...image, id: id(15), imageId: id(97) }])
    expect([...repo.imageIds()].sort()).toEqual([id(97), id(99)])
    expect(repo.clear(A)).toEqual([id(99)])
    expect(repo.load(A).size).toBe(0)
    expect([...repo.imageIds()]).toEqual([id(97)])
  })
})

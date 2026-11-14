import type { Db } from './database'

/** A web tile as saved: the address is checked again (normalizeAddress) before anything loads it. */
export type SavedTile = { id: string; workspaceId: string; url: string; x: number; y: number; w: number; h: number }
type Row = { id: string; workspace_id: string; url: string; x: number; y: number; w: number; h: number }

/** The web tiles of each project. Prepared statements only; a save replaces the project's list in one transaction. */
export class SqliteWebTileRepo {
  private q
  readonly replace: (root: string, tiles: SavedTile[]) => void
  constructor(private db: Db) {
    const p = (sql: string) => db.prepare(sql)
    this.q = {
      ensure: p('INSERT OR IGNORE INTO projects (root, opened_at) VALUES (?, 0)'),
      clear: p('DELETE FROM web_tiles WHERE project = ?'),
      ins: p('INSERT INTO web_tiles (project, id, workspace_id, url, x, y, w, h, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      sel: p('SELECT id, workspace_id, url, x, y, w, h FROM web_tiles WHERE project = ? ORDER BY ord'),
    }
    this.replace = db.transaction((root: string, tiles: SavedTile[]) => {
      this.q.ensure.run(root)
      this.q.clear.run(root)
      tiles.forEach((t, i) => this.q.ins.run(root, t.id, t.workspaceId, t.url, t.x, t.y, t.w, t.h, i))
    })
  }

  load(root: string): SavedTile[] {
    return (this.q.sel.all(root) as Row[]).map((r) => ({ id: r.id, workspaceId: r.workspace_id, url: r.url, x: r.x, y: r.y, w: r.w, h: r.h }))
  }

  /** Empty board: the project's tiles go. */
  clear(root: string): void {
    this.q.clear.run(root)
  }
}

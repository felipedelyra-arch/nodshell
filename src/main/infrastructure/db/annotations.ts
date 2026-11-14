import { ANNOTATIONS_MAX, annotationSchema, type Annotation } from '../../../shared/annotation'
import type { Db } from './database'

type Row = { workspace_id: string; id: string; kind: string; image_id: string | null; data: string }

/** The annotations of each project and workspace. Prepared statements only; a save replaces one workspace's list in one transaction. */
export class SqliteAnnotationRepo {
  private q
  /** Replaces one workspace's list; returns the image ids it no longer has. */
  readonly replace: (root: string, workspaceId: string, items: Annotation[]) => string[]
  constructor(private db: Db) {
    const p = (sql: string) => db.prepare(sql)
    this.q = {
      ensure: p('INSERT OR IGNORE INTO projects (root, opened_at) VALUES (?, 0)'),
      clearWs: p('DELETE FROM annotations WHERE project = ? AND workspace_id = ?'),
      ins: p('INSERT INTO annotations (project, workspace_id, id, kind, image_id, data, ord) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      sel: p('SELECT workspace_id, id, kind, image_id, data FROM annotations WHERE project = ? ORDER BY workspace_id, ord'),
      workspaces: p('SELECT DISTINCT workspace_id FROM annotations WHERE project = ?'),
      images: p('SELECT image_id FROM annotations WHERE project = ? AND workspace_id = ? AND image_id IS NOT NULL'),
      projectImages: p('SELECT image_id FROM annotations WHERE project = ? AND image_id IS NOT NULL'),
      clear: p('DELETE FROM annotations WHERE project = ?'),
      allImages: p('SELECT DISTINCT image_id FROM annotations WHERE image_id IS NOT NULL'),
    }
    this.replace = db.transaction((root: string, workspaceId: string, items: Annotation[]) => {
      this.q.ensure.run(root)
      const before = (this.q.images.all(root, workspaceId) as { image_id: string }[]).map((r) => r.image_id)
      this.q.clearWs.run(root, workspaceId)
      items.forEach((a, i) => this.q.ins.run(root, workspaceId, a.id, a.kind, a.kind === 'image' ? a.imageId : null, JSON.stringify(a), i))
      const now = new Set(items.flatMap((a) => (a.kind === 'image' ? [a.imageId] : [])))
      return before.filter((id) => !now.has(id))
    })
  }

  /** Per workspace, in order. Nothing read back is trusted: a row that does not parse as an annotation is dropped, the rest stays. */
  load(root: string): Map<string, Annotation[]> {
    const out = new Map<string, Annotation[]>()
    for (const r of this.q.sel.all(root) as Row[]) {
      const list = out.get(r.workspace_id) ?? []
      if (list.length >= ANNOTATIONS_MAX) continue
      try {
        const a = annotationSchema.safeParse(JSON.parse(r.data))
        if (a.success && a.data.id === r.id && a.data.kind === r.kind) list.push(a.data)
      } catch {
        // not JSON: dropped
      }
      out.set(r.workspace_id, list)
    }
    return out
  }

  /** The image ids the project's annotations use. */
  projectImageIds(root: string): Set<string> {
    return new Set((this.q.projectImages.all(root) as { image_id: string }[]).map((r) => r.image_id.toLowerCase()))
  }

  /** Deletes these workspaces' annotations (they were closed); returns the image ids of what went. Other workspaces are never touched. */
  prune(root: string, drop: string[]): string[] {
    return this.db.transaction(() => {
      const gone: string[] = []
      for (const { workspace_id } of this.q.workspaces.all(root) as { workspace_id: string }[]) {
        if (!drop.includes(workspace_id)) continue
        for (const { image_id } of this.q.images.all(root, workspace_id) as { image_id: string }[]) gone.push(image_id)
        this.q.clearWs.run(root, workspace_id)
      }
      return gone
    })()
  }

  /** Empty board: everything of the project; returns its image ids. */
  clear(root: string): string[] {
    return this.db.transaction(() => {
      const gone = (this.q.projectImages.all(root) as { image_id: string }[]).map((r) => r.image_id)
      this.q.clear.run(root)
      return gone
    })()
  }

  /** Every image any project still uses (the start-up cleanup deletes the other files). */
  imageIds(): Set<string> {
    return new Set((this.q.allImages.all() as { image_id: string }[]).map((r) => r.image_id.toLowerCase()))
  }
}

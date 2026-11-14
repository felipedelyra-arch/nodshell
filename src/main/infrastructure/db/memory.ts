import type { MemoryScope } from '../../../shared/memory'
import type { MemoryEntry, MemoryRepo } from '../../application/memory'
import type { Db } from './database'

/** Prepared statements only. The global text has the key ''; a repository's text has its root as key. */
export class SqliteMemoryRepo implements MemoryRepo {
  private qGet
  private qSet
  constructor(db: Db) {
    this.qGet = db.prepare('SELECT content, updated_at, updated_by FROM memory WHERE scope = ? AND key = ?')
    this.qSet = db.prepare('INSERT INTO memory (scope, key, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
  }
  get(scope: MemoryScope, key: string): MemoryEntry | null {
    const r = this.qGet.get(scope, key) as { content: string; updated_at: number; updated_by: string } | undefined
    return r ? { content: r.content, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
  }
  set(scope: MemoryScope, key: string, e: MemoryEntry): void {
    this.qSet.run(scope, key, e.content, e.updatedAt, e.updatedBy)
  }
}

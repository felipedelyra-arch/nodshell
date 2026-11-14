import type { Db } from './database'

/** Key/value app settings. Prepared statements only; values are text and validated by the caller. */
export class SqliteSettingsRepo {
  private q
  constructor(db: Db) {
    this.q = { get: db.prepare('SELECT value FROM settings WHERE key = ?'), set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value') }
  }

  get(key: string): string | null {
    return (this.q.get.get(key) as { value: string } | undefined)?.value ?? null
  }

  set(key: string, value: string): void {
    this.q.set.run(key, value)
  }
}

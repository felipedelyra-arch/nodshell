import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/infrastructure/db/database'
import { SqliteSettingsRepo } from '../../src/main/infrastructure/db/settings'

let dir: string
let db: Db
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-canvas-settings-'))
  db = openDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SqliteSettingsRepo', () => {
  it('returns null until set, then the latest value (upsert)', () => {
    const repo = new SqliteSettingsRepo(db)
    expect(repo.get('liveLimit')).toBeNull()
    repo.set('liveLimit', '12')
    repo.set('liveLimit', '30')
    expect(repo.get('liveLimit')).toBe('30')
  })
})

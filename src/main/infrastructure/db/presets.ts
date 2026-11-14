import { MODEL_CHOICES } from '../../../shared/agent'
import type { Preset, PresetRepo } from '../../domain/preset'
import type { Db } from './database'

type Row = { id: string; name: string; role: string; adapter: 'claude' | 'generic'; model: string | null; system_prompt: string; builtin: number; created_at: number }

const toPreset = (r: Row): Preset => ({ id: r.id, name: r.name, role: r.role, adapter: r.adapter, model: MODEL_CHOICES.find((m) => m === r.model) ?? null, systemPrompt: r.system_prompt, builtin: r.builtin === 1, createdAt: r.created_at })

/** Prepared statements only; every value is bound, never concatenated. */
export class SqlitePresetRepo implements PresetRepo {
  private qList
  private qGet
  private qInsert
  private qUpdate
  private qDelete
  constructor(db: Db) {
    this.qList = db.prepare('SELECT * FROM presets ORDER BY builtin DESC, rowid')
    this.qGet = db.prepare('SELECT * FROM presets WHERE id = ?')
    this.qInsert = db.prepare('INSERT INTO presets (id, name, role, adapter, model, system_prompt, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    this.qUpdate = db.prepare('UPDATE presets SET name = ?, role = ?, model = ?, system_prompt = ? WHERE id = ?')
    this.qDelete = db.prepare('DELETE FROM presets WHERE id = ? AND builtin = 0')
  }
  list(): Preset[] {
    return (this.qList.all() as Row[]).map(toPreset)
  }
  get(id: string): Preset | undefined {
    const r = this.qGet.get(id) as Row | undefined
    return r && toPreset(r)
  }
  insert(p: Preset): void {
    this.qInsert.run(p.id, p.name, p.role, p.adapter, p.model, p.systemPrompt, p.builtin ? 1 : 0, p.createdAt)
  }
  update(p: Preset): void {
    this.qUpdate.run(p.name, p.role, p.model, p.systemPrompt, p.id)
  }
  delete(id: string): boolean {
    return this.qDelete.run(id).changes > 0
  }
}

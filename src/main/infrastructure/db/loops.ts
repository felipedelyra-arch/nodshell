import type { LoopTrigger, SavedLoop } from '../../domain/loop'
import type { Db } from './database'

type Row = { id: string; workspace_id: string; agent_id: string; prompt: string; trigger_kind: LoopTrigger['kind']; trigger_sec: number | null; terminal_id: string | null; trigger_text: string | null; goal: string; max_runs: number }

/** Back from a row; a row that does not make a trigger is left out (everything else is checked again before a loop is made). */
function triggerOf(r: Row): LoopTrigger | null {
  if (r.trigger_kind === 'schedule' && r.trigger_sec !== null) return { kind: 'schedule', everySec: r.trigger_sec }
  if (r.trigger_kind === 'idle' && r.trigger_sec !== null) return { kind: 'idle', afterSec: r.trigger_sec }
  if (r.trigger_kind === 'output' && r.terminal_id !== null && r.trigger_text !== null) return { kind: 'output', terminalId: r.terminal_id, text: r.trigger_text }
  return null
}

/** The loops of each project. Prepared statements only; a save replaces the project's list in one transaction. */
export class SqliteLoopRepo {
  private q
  readonly replace: (root: string, loops: SavedLoop[]) => void
  constructor(private db: Db) {
    const p = (sql: string) => db.prepare(sql)
    this.q = {
      ensure: p('INSERT OR IGNORE INTO projects (root, opened_at) VALUES (?, 0)'),
      clear: p('DELETE FROM loops WHERE project = ?'),
      ins: p('INSERT INTO loops (project, id, workspace_id, agent_id, prompt, trigger_kind, trigger_sec, terminal_id, trigger_text, goal, max_runs, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      sel: p('SELECT id, workspace_id, agent_id, prompt, trigger_kind, trigger_sec, terminal_id, trigger_text, goal, max_runs FROM loops WHERE project = ? ORDER BY ord'),
    }
    this.replace = db.transaction((root: string, loops: SavedLoop[]) => {
      this.q.ensure.run(root)
      this.q.clear.run(root)
      loops.forEach((l, i) => {
        const t = l.trigger
        const sec = t.kind === 'schedule' ? t.everySec : t.kind === 'idle' ? t.afterSec : null
        this.q.ins.run(root, l.id, l.workspaceId, l.agentId, l.prompt, t.kind, sec, t.kind === 'output' ? t.terminalId : null, t.kind === 'output' ? t.text : null, l.goal, l.maxRuns, i)
      })
    })
  }

  load(root: string): SavedLoop[] {
    return (this.q.sel.all(root) as Row[]).flatMap((r) => {
      const trigger = triggerOf(r)
      return trigger ? [{ id: r.id, workspaceId: r.workspace_id, agentId: r.agent_id, prompt: r.prompt, trigger, goal: r.goal, maxRuns: r.max_runs }] : []
    })
  }

  /** Empty board: the project's loops go. */
  clear(root: string): void {
    this.q.clear.run(root)
  }
}

import type { SavedBoard, SavedNode } from '../../domain/board'
import type { SourceEndpoint, TargetEndpoint } from '../../domain/edge'
import type { Db } from './database'

type WsRow = { id: string; name: string; ord: number; vx: number; vy: number; zoom: number; active: number }
type NodeRow = { id: string; workspace_id: string; kind: SavedNode['kind']; x: number; y: number; w: number; h: number; pinned: number; parent_id: string | null; ord: number }
type AgentRow = { id: string; role: string; preset_id: string | null; model: string | null; name: string; system_prompt: string; branch: string; worktree: string; base: string; session_id: string; pending: number }
type GroupRow = { id: string; name: string; collapsed: number; preset_id: string | null }
type EdgeRow = { id: string; workspace_id: string; source_kind: SourceEndpoint['kind']; source_id: string; target_kind: TargetEndpoint['kind']; target_id: string; template: string; condition: string; paused: string | null }

/** The board of each project (repository root). Prepared statements only; a save replaces the whole board in one transaction. */
export class SqliteBoardRepo {
  private q
  readonly save: (root: string, b: SavedBoard) => void
  constructor(private db: Db) {
    const p = (sql: string) => db.prepare(sql)
    this.q = {
      // opened_at is a sequence, not a clock: the last one touched always wins
      touch: p('INSERT INTO projects (root, opened_at) VALUES (?, (SELECT COALESCE(MAX(opened_at), 0) + 1 FROM projects)) ON CONFLICT(root) DO UPDATE SET opened_at = excluded.opened_at'),
      ensure: p('INSERT OR IGNORE INTO projects (root, opened_at) VALUES (?, 0)'),
      last: p('SELECT root FROM projects ORDER BY opened_at DESC, rowid DESC LIMIT 1'),
      // children first: squads reference agents and groups, nodes and edges reference workspaces
      clear: ['squads', 'edges', 'nodes', 'groups', 'agents', 'workspaces'].map((t) => p(`DELETE FROM ${t} WHERE project = ?`)),
      insWs: p('INSERT INTO workspaces (id, project, name, ord, vx, vy, zoom, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      insAgent: p('INSERT INTO agents (id, project, role, preset_id, model, name, system_prompt, branch, worktree, base, session_id, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insGroup: p('INSERT INTO groups (id, project, name, collapsed, preset_id) VALUES (?, ?, ?, ?, ?)'),
      insNode: p('INSERT INTO nodes (id, project, workspace_id, kind, x, y, w, h, pinned, parent_id, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insSquad: p('INSERT INTO squads (id, project, orchestrator_id) VALUES (?, ?, ?)'),
      insSquadGroup: p('INSERT INTO squad_groups (squad_id, group_id, ord) VALUES (?, ?, ?)'),
      insExtra: p('INSERT INTO squad_extras (squad_id, agent_id) VALUES (?, ?)'),
      insEdge: p('INSERT INTO edges (id, project, workspace_id, source_kind, source_id, target_kind, target_id, template, condition, paused) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      selWs: p('SELECT * FROM workspaces WHERE project = ? ORDER BY ord, rowid'),
      selNodes: p('SELECT * FROM nodes WHERE project = ? ORDER BY rowid'),
      selAgents: p('SELECT * FROM agents WHERE project = ? ORDER BY rowid'),
      selGroups: p('SELECT * FROM groups WHERE project = ? ORDER BY rowid'),
      selSquads: p('SELECT id, orchestrator_id FROM squads WHERE project = ? ORDER BY rowid'),
      selSquadGroups: p('SELECT group_id FROM squad_groups WHERE squad_id = ? ORDER BY ord'),
      selExtras: p('SELECT agent_id FROM squad_extras WHERE squad_id = ? ORDER BY rowid'),
      selEdges: p('SELECT * FROM edges WHERE project = ? ORDER BY rowid'),
    }
    this.save = db.transaction((root: string, b: SavedBoard) => {
      const q = this.q
      q.ensure.run(root)
      for (const s of q.clear) s.run(root)
      for (const w of b.workspaces) q.insWs.run(w.id, root, w.name, w.order, w.viewport.x, w.viewport.y, w.viewport.zoom, w.active ? 1 : 0)
      for (const a of b.agents) q.insAgent.run(a.id, root, a.role, a.presetId, a.model, a.name, a.systemPrompt, a.branch, a.worktree, a.base, a.sessionId, a.pending ? 1 : 0)
      for (const g of b.groups) q.insGroup.run(g.id, root, g.name, g.collapsed ? 1 : 0, g.presetId)
      for (const n of b.nodes) q.insNode.run(n.id, root, n.workspaceId, n.kind, n.x, n.y, n.w, n.h, n.pinned ? 1 : 0, n.parentId, n.order)
      for (const s of b.squads) {
        q.insSquad.run(s.id, root, s.orchestratorId)
        s.groupIds.forEach((g, i) => q.insSquadGroup.run(s.id, g, i))
        for (const a of s.extraIds) q.insExtra.run(s.id, a)
      }
      for (const e of b.edges) q.insEdge.run(e.id, root, e.workspaceId, e.source.kind, e.source.id, e.target.kind, e.target.id, e.template, e.condition, e.paused)
    })
  }

  /** The project was opened now: it is the one reopened at the next start. */
  touch(root: string): void {
    this.q.touch.run(root)
  }

  lastProject(): string | null {
    return (this.q.last.get() as { root: string } | undefined)?.root ?? null
  }

  load(root: string): SavedBoard | null {
    const q = this.q
    const workspaces = (q.selWs.all(root) as WsRow[]).map((w) => ({ id: w.id, name: w.name, order: w.ord, viewport: { x: w.vx, y: w.vy, zoom: w.zoom }, active: w.active === 1 }))
    if (workspaces.length === 0) return null
    return {
      workspaces,
      nodes: (q.selNodes.all(root) as NodeRow[]).map((n) => ({ id: n.id, kind: n.kind, workspaceId: n.workspace_id, x: n.x, y: n.y, w: n.w, h: n.h, pinned: n.pinned === 1, parentId: n.parent_id, order: n.ord })),
      agents: (q.selAgents.all(root) as AgentRow[]).map((a) => ({ id: a.id, role: a.role, presetId: a.preset_id, model: a.model, name: a.name, systemPrompt: a.system_prompt, branch: a.branch, worktree: a.worktree, base: a.base, sessionId: a.session_id, pending: a.pending === 1 })),
      groups: (q.selGroups.all(root) as GroupRow[]).map((g) => ({ id: g.id, name: g.name, collapsed: g.collapsed === 1, presetId: g.preset_id })),
      squads: (q.selSquads.all(root) as { id: string; orchestrator_id: string }[]).map((s) => ({
        id: s.id,
        orchestratorId: s.orchestrator_id,
        groupIds: (q.selSquadGroups.all(s.id) as { group_id: string }[]).map((r) => r.group_id),
        extraIds: (q.selExtras.all(s.id) as { agent_id: string }[]).map((r) => r.agent_id),
      })),
      edges: (q.selEdges.all(root) as EdgeRow[]).map((e) => ({ id: e.id, workspaceId: e.workspace_id, source: { kind: e.source_kind, id: e.source_id }, target: { kind: e.target_kind, id: e.target_id }, template: e.template, condition: e.condition, paused: e.paused })),
    }
  }

  /** Empty board: the project's saved board goes, the project stays known. */
  clear(root: string): void {
    this.db.transaction(() => {
      for (const s of this.q.clear) s.run(root)
    })()
  }
}

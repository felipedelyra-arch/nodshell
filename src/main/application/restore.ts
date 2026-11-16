import { CONTROL_RE, GROUP_NAME_MAX } from '../../shared/preset'
import { AgentError, type ConfirmDiscard, type RemovalOutcome, type Repo, type Worktree } from '../domain/agent'
import type { SavedBoard, SavedNode } from '../domain/board'
import type { RestoreRequest, SpawnedAgent } from './agents'
import { planRestore, rebuildBoard, savedAgentProblem, type Layout, type Pending, type Skipped } from './board'
import type { FlowEngine } from './flow'
import type { GroupRegistry } from './groups'
import type { Slots } from './spawnMany'
import type { SquadRegistry } from './squads'

export type RestoreDeps = {
  worktrees: { adopt(repo: Repo, saved: { path: string; branch: string; role: string; base: string }): Promise<Worktree>; remove(wt: Worktree, confirm?: ConfirmDiscard): Promise<RemovalOutcome> }
  agents: { restore(ownerId: number, req: RestoreRequest): Promise<SpawnedAgent> }
  consoles: { spawn(ownerId: number): { id: string; name: string } }
  groups: Pick<GroupRegistry, 'create'>
  squads: Pick<SquadRegistry, 'create'>
  flow: Pick<FlowEngine, 'create'>
  slots: Slots
  /** the CLI has a conversation to resume for this session in this worktree (else `--resume` would fail): relaunched fresh otherwise */
  canResume(worktree: string, sessionId: string): boolean
  /** the window is gone or the app is leaving: stop here */
  cancelled(): boolean
  /** stops what this restore started (agents keep their worktrees), when it was cancelled */
  stop(ownerId: number, ids: string[]): Promise<void>
}

export type Restored = {
  cancelled: boolean
  /** the saved board around what came back, with the new terminal ids */
  board: SavedBoard
  agents: Map<string, SpawnedAgent>
  consoles: Map<string, string>
  /** saved terminal id -> new id, for each terminal that came back */
  ids: Map<string, string>
  skipped: Skipped[]
  /** saved agents that did not come back but stay on the saved board (with their groups, squads and edges), to be tried again (and cleaned up by Empty board) */
  pending: Pending
}

const NO_PENDING = (): Pending => ({ agents: [], nodes: [], groups: [], squads: [], edges: [] })

const SIZE = { cols: 80, rows: 24 }
const validName = (n: string) => n.trim().length > 0 && n.length <= GROUP_NAME_MAX && !CONTROL_RE.test(n)

/** Each saved agent whose fields are valid gets its worktree checked again on disk; returns the usable ones and why the rest are not. */
async function checkWorktrees(d: Pick<RestoreDeps, 'worktrees'>, repo: Repo, b: SavedBoard): Promise<{ trees: Map<string, Worktree>; problems: Map<string, string> }> {
  const trees = new Map<string, Worktree>()
  const problems = new Map<string, string>()
  for (const a of b.agents) {
    if (savedAgentProblem(a)) continue // planRestore says why
    try {
      trees.set(a.id, await d.worktrees.adopt(repo, { path: a.worktree, branch: a.branch, role: a.role, base: a.base }))
    } catch (e) {
      problems.set(a.id, e instanceof AgentError && e.message ? e.message : 'its worktree is not valid')
    }
  }
  return { trees, problems }
}

/**
 * RestoreBoard: relaunches, one at a time and within the free terminals, each saved agent in its own revalidated worktree (resumed
 * when its CLI has the conversation, else fresh) and each console as a new shell, then puts back the groups, squads and edges that
 * still have both ends. Never throws for one terminal: what did not come back is listed in `skipped` and, for agents, kept in
 * `pending`. With `only`, just the terminals the user picked are relaunched. Cancelled (window gone, app leaving) before any spawn: what already started is stopped and nothing else is done.
 */
export async function restoreBoard(d: RestoreDeps, ownerId: number, repo: Repo, saved: SavedBoard, resume: boolean, only?: ReadonlySet<string>): Promise<Restored> {
  const { trees, problems } = await checkWorktrees(d, repo, saved)
  const plan = planRestore(saved, problems, d.slots.free(), only, d.slots.freeOfLimit())
  const ws = new Map(saved.nodes.map((n) => [n.id, n.workspaceId]))
  const ids = new Map<string, string>()
  const agents = new Map<string, SpawnedAgent>()
  const consoles = new Map<string, string>()
  const skipped = [...plan.skipped]
  const slots = d.slots.reserve(plan.agents.length + plan.consoles.length, true) // the plan was cut to what is free: not checked twice
  let cancelled = false
  try {
    for (const a of plan.agents) {
      if ((cancelled ||= d.cancelled())) break
      try {
        // checked right before the spawn, which has no await in between: nothing starts for a window that is gone
        const s = await d.agents.restore(ownerId, { role: a.role, model: a.model ?? undefined, systemPrompt: a.systemPrompt || undefined, presetId: a.presetId ?? undefined, ...SIZE, workspaceId: ws.get(a.id), name: a.name, worktree: trees.get(a.id)!, sessionId: a.sessionId, resume: resume && d.canResume(trees.get(a.id)!.path, a.sessionId) })
        ids.set(a.id, s.id)
        agents.set(s.id, s)
      } catch {
        skipped.push({ name: a.name, branch: a.branch, id: a.id, keep: true, reason: 'it could not start' })
      } finally {
        slots.use()
      }
    }
    for (const c of plan.consoles) {
      if ((cancelled ||= d.cancelled())) break
      try {
        const s = d.consoles.spawn(ownerId)
        ids.set(c.id, s.id)
        consoles.set(s.id, s.name)
      } catch {
        skipped.push({ name: 'a console', reason: 'it could not start' })
      } finally {
        slots.use(false)
      }
    }
  } finally {
    slots.release()
  }
  const kept = new Set(skipped.flatMap((x) => (x.keep && x.id ? [x.id] : [])))
  if (cancelled || d.cancelled()) {
    await d.stop(ownerId, [...ids.values()]).catch(() => undefined)
    return { cancelled: true, board: { ...saved, nodes: [], agents: [], groups: [], squads: [], edges: [] }, agents: new Map(), consoles: new Map(), ids: new Map(), skipped: [], pending: NO_PENDING() }
  }
  const board = rebuildBoard(saved, ids)
  // what the agents left behind still hold: their groups, the squads, and the edges that lost an end with them (restored ends under their new ids)
  const now = (id: string) => ids.get(id) ?? id
  const rebuilt = new Set(board.edges.map((e) => e.id))
  const end = <E extends { kind: string; id: string }>(e: E): E => (e.kind === 'agent' ? { ...e, id: now(e.id) } : { ...e })
  const pGroups = saved.groups.filter((g) => saved.nodes.some((n) => n.parentId === g.id && kept.has(n.id)))
  const held = new Set([...kept, ...pGroups.map((g) => g.id), ...saved.squads.map((q) => q.id)])
  const pending: Pending = {
    agents: saved.agents.filter((a) => kept.has(a.id)),
    nodes: saved.nodes.filter((n) => held.has(n.id)),
    groups: pGroups,
    squads: saved.squads.map((q) => ({ ...q, orchestratorId: now(q.orchestratorId), extraIds: q.extraIds.map(now) })),
    edges: kept.size === 0 ? [] : saved.edges.filter((e) => !rebuilt.has(e.id)).map((e) => ({ ...e, source: end(e.source), target: end(e.target) })),
  }
  const nodeOf = new Map(board.nodes.map((n) => [n.id, n]))
  const membersOf = (parent: string) => board.nodes.filter((n) => n.parentId === parent && (n.kind === 'agent' || n.kind === 'console')).sort((x, y) => x.order - y.order).map((n) => n.id)
  board.groups = board.groups.filter((g) => {
    try {
      d.groups.create(ownerId, validName(g.name) ? g.name : 'Group', membersOf(g.id), { id: g.id, presetId: g.presetId ?? undefined, spawned: true, workspaceId: nodeOf.get(g.id)?.workspaceId })
      return true
    } catch {
      return false
    }
  })
  const groupIds = new Set(board.groups.map((g) => g.id))
  board.squads = board.squads.map((q) => {
    const groups = q.groupIds.filter((g) => groupIds.has(g))
    const s = d.squads.create(ownerId, q.orchestratorId, groups, { id: q.id, extraIds: q.extraIds })
    return { id: s.id, orchestratorId: s.orchestratorId, groupIds: [...s.groupIds], extraIds: [...s.extraIds] }
  })
  board.edges = board.edges.filter((e) => {
    try {
      d.flow.create(ownerId, e.source, e.target, { id: e.id, template: e.template, condition: e.condition, paused: e.paused })
      return true
    } catch {
      return false // an end went away, or it would cross workspaces
    }
  })
  const keep = new Set([...ids.values(), ...groupIds, ...board.squads.map((q) => q.id)])
  board.nodes = board.nodes.filter((n) => keep.has(n.id)).map((n): SavedNode => (n.parentId && !keep.has(n.parentId) ? { ...n, parentId: null } : n))
  return { cancelled: false, board, agents, consoles, ids, skipped, pending }
}

/**
 * Empty board: every saved agent's worktree that checks out gets the usual removal policy (dirty work only goes on an explicit
 * Discard). A worktree that does not check out is NEVER touched: it is listed (name, branch, why) for the user to decide.
 */
export async function discardWorktrees(d: Pick<RestoreDeps, 'worktrees'>, repo: Repo, saved: SavedBoard, confirm: ConfirmDiscard): Promise<{ kept: number; archived: number; left: Skipped[] }> {
  const { trees, problems } = await checkWorktrees(d, repo, saved)
  const left = saved.agents.flatMap((a) => (problems.has(a.id) ? [{ name: a.name, branch: a.branch, reason: problems.get(a.id)! }] : []))
  let kept = 0
  let archived = 0
  for (const wt of trees.values()) {
    const r = await d.worktrees.remove(wt, confirm).catch(() => 'kept' as const)
    if (r === 'kept') kept++
    if (r === 'archived') archived++
  }
  return { kept, archived, left }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0)
const coord = (v: number) => clamp(v, -1_000_000, 1_000_000)

/** The layout main keeps for the restored board until the renderer reports its own. */
export function layoutOf(b: SavedBoard): Layout {
  const collapsed = new Set(b.groups.filter((g) => g.collapsed).map((g) => g.id))
  const workspaces = [...b.workspaces].sort((x, y) => x.order - y.order)
  return {
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, viewport: { ...w.viewport } })),
    active: (workspaces.find((w) => w.active) ?? workspaces[0])?.id ?? '',
    nodes: b.nodes.map((n) => ({ id: n.id, workspaceId: n.workspaceId, x: n.x, y: n.y, w: n.w, h: n.h, pinned: n.pinned, collapsed: collapsed.has(n.id) })),
  }
}

export type AgentInfo = { id: string; name: string; role: string; branch: string; model: string; state: SpawnedAgent['state']; statusUnavailable: boolean }

/** What the renderer gets to rebuild its nodes: no path, every saved string and number checked or bounded. */
export function boardView<E>(r: Restored, edges: E[]) {
  const b = r.board
  const workspaces = [...b.workspaces].sort((x, y) => x.order - y.order)
  const roleOf = (groupId: string) => {
    const first = b.nodes.find((n) => n.parentId === groupId && r.agents.has(n.id))
    return (first && r.agents.get(first.id)?.role) || 'group'
  }
  const at = (n: SavedNode) => ({ workspaceId: n.workspaceId, x: coord(n.x), y: coord(n.y) })
  const info = (a: SpawnedAgent): AgentInfo => ({ id: a.id, name: a.name, role: a.role, branch: a.branch, model: a.model, state: a.state, statusUnavailable: a.statusUnavailable })
  return {
    workspaces: workspaces.map((w, i) => ({ id: w.id, name: validName(w.name) ? w.name : `Workspace ${i + 1}`, viewport: { x: coord(w.viewport.x), y: coord(w.viewport.y), zoom: clamp(w.viewport.zoom, 0.05, 4) || 1 } })),
    active: (workspaces.find((w) => w.active) ?? workspaces[0])!.id,
    terminals: b.nodes.flatMap((n) => {
      const a = r.agents.get(n.id)
      const c = r.consoles.get(n.id)
      return a || c !== undefined ? [{ id: n.id, ...at(n), w: clamp(n.w, 0, 100_000), h: clamp(n.h, 0, 100_000), pinned: n.pinned, name: a ? a.name : c!, agent: a ? info(a) : null }] : []
    }),
    groups: b.groups.flatMap((g) => {
      const n = b.nodes.find((x) => x.id === g.id)
      const memberIds = b.nodes.filter((x) => x.parentId === g.id).sort((x, y) => x.order - y.order).map((x) => x.id)
      return n && memberIds.length ? [{ id: g.id, name: validName(g.name) ? g.name : 'Group', ...at(n), collapsed: g.collapsed, memberIds }] : []
    }),
    squads: b.squads.flatMap((q) => {
      const n = b.nodes.find((x) => x.id === q.id)
      return n ? [{ id: q.id, ...at(n), orchestratorId: q.orchestratorId, groups: q.groupIds.map((id) => ({ id, role: roleOf(id) })) }] : []
    }),
    edges,
  }
}

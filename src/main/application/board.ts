import { AGENT_NAME_RE, MODEL_CHOICES, PROMPT_MAX, WORKSPACES_MAX } from '../../shared/agent'
import { CONDITION_MAX, REASON_MAX, TEMPLATE_MAX } from '../../shared/flow'
import { CONTROL_RE, GROUP_NAME_MAX } from '../../shared/preset'
import { isValidRole, slotOf, type Worktree } from '../domain/agent'
import type { SavedAgent, SavedBoard, SavedEdge, SavedGroup, SavedNode, SavedSquad, SavedWorkspace, Viewport } from '../domain/board'
import type { Edge } from '../domain/edge'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** What the renderer last reported of the board: ids, places, sizes, pins, collapsed groups, workspaces and viewports. Never a path. */
export type LayoutNode = { id: string; workspaceId: string; x: number; y: number; w: number; h: number; pinned: boolean; collapsed: boolean }
export type Layout = { workspaces: { id: string; name: string; viewport: Viewport }[]; active: string; nodes: LayoutNode[] }

export type LiveAgent = { id: string; workspaceId?: string; role: string; presetId?: string; model?: string; name: string; systemPrompt?: string; worktree: Worktree; sessionId: string }
export type SnapshotInput = {
  agents: LiveAgent[]
  /** consoles (terminals that are not agents) */
  consoles: string[]
  groups: { id: string; name: string; memberIds: string[]; presetId?: string; workspaceId?: string }[]
  squads: { id: string; orchestratorId: string; groupIds: string[]; extraIds: string[] }[]
  edges: Edge[]
  layout: Layout | null
  /** saved agents that did not come back at the last start: kept on the saved board (with their nodes) to be tried again */
  pending?: { agents: SavedAgent[]; nodes: SavedNode[] }
}

/** Keeps only the layout of ids this window owns (anything else is ignored), with workspaces it names. */
export function acceptLayout(l: Layout, known: (id: string) => boolean): Layout {
  const ws = new Set(l.workspaces.map((w) => w.id))
  return { workspaces: l.workspaces, active: ws.has(l.active) ? l.active : (l.workspaces[0]?.id ?? l.active), nodes: l.nodes.filter((n) => ws.has(n.workspaceId) && known(n.id)) }
}

/** The board as main knows it, with the renderer's layout: everything stays consistent (every reference points at something saved). */
export function buildSnapshot(s: SnapshotInput, newId: () => string): SavedBoard {
  const at = new Map((s.layout?.nodes ?? []).map((n) => [n.id, n]))
  let workspaces: SavedWorkspace[] = (s.layout?.workspaces ?? []).map((w, i) => ({ id: w.id, name: w.name, order: i, viewport: { ...w.viewport }, active: w.id === s.layout?.active }))
  if (workspaces.length === 0) {
    const ids = [...new Set([...s.agents.flatMap((a) => (a.workspaceId ? [a.workspaceId] : [])), ...s.groups.flatMap((g) => (g.workspaceId ? [g.workspaceId] : []))])]
    if (ids.length === 0 && (s.agents.length || s.consoles.length)) ids.push(newId())
    workspaces = ids.map((id, i) => ({ id, name: `Workspace ${i + 1}`, order: i, viewport: { x: 0, y: 0, zoom: 1 }, active: i === 0 }))
  }
  const wsIds = new Set(workspaces.map((w) => w.id))
  const ws = (id: string, own?: string) => (own && wsIds.has(own) ? own : at.get(id) && wsIds.has(at.get(id)!.workspaceId) ? at.get(id)!.workspaceId : workspaces[0]!.id)
  const place = (id: string) => {
    const l = at.get(id)
    return { x: l?.x ?? 0, y: l?.y ?? 0, w: l?.w ?? 0, h: l?.h ?? 0 }
  }
  const groupOf = (id: string) => s.groups.find((g) => g.memberIds.includes(id))
  const ledBy = (id: string) => s.squads.find((q) => q.orchestratorId === id)
  const card = (id: string, kind: 'agent' | 'console', own?: string): SavedNode => {
    const g = groupOf(id)
    const q = ledBy(id)
    const parentId = q?.id ?? g?.id ?? null
    return { id, kind, workspaceId: ws(id, own), ...place(id), pinned: at.get(id)?.pinned ?? false, parentId, order: g ? g.memberIds.indexOf(id) : 0 }
  }
  const agents: SavedAgent[] = s.agents.map((a) => ({ id: a.id, role: a.role, presetId: a.presetId ?? null, model: a.model ?? null, name: a.name, systemPrompt: a.systemPrompt ?? '', branch: a.worktree.branch, worktree: a.worktree.path, base: a.worktree.base, sessionId: a.sessionId, pending: false }))
  const agentIds = new Set(agents.map((a) => a.id))
  const nodes: SavedNode[] = [...s.agents.map((a) => card(a.id, 'agent', a.workspaceId)), ...s.consoles.map((id) => card(id, 'console'))]
  const cardWs = new Map(nodes.map((n) => [n.id, n.workspaceId]))
  const groups: SavedGroup[] = []
  for (const g of s.groups) {
    if (!g.memberIds.some((m) => cardWs.has(m))) continue
    groups.push({ id: g.id, name: g.name, collapsed: at.get(g.id)?.collapsed ?? false, presetId: g.presetId ?? null })
    nodes.push({ id: g.id, kind: 'group', workspaceId: ws(g.id, g.workspaceId ?? cardWs.get(g.memberIds.find((m) => cardWs.has(m))!)), ...place(g.id), pinned: false, parentId: null, order: 0 })
  }
  const groupIds = new Set(groups.map((g) => g.id))
  const squads: SavedSquad[] = s.squads
    .filter((q) => agentIds.has(q.orchestratorId))
    .map((q) => ({ id: q.id, orchestratorId: q.orchestratorId, groupIds: q.groupIds.filter((g) => groupIds.has(g)), extraIds: q.extraIds.filter((a) => agentIds.has(a)) }))
  for (const q of squads) nodes.push({ id: q.id, kind: 'orchestrator', workspaceId: cardWs.get(q.orchestratorId)!, ...place(q.id), pinned: false, parentId: null, order: 0 })
  // agents that did not come back stay saved, as they were, so the next start tries them again and Empty board can clean them up
  const groupNode = new Set(nodes.filter((n) => n.kind === 'group').map((n) => n.id))
  for (const a of s.pending?.agents ?? []) {
    const n = s.pending?.nodes.find((x) => x.id === a.id)
    if (agentIds.has(a.id) || !n) continue
    agents.push({ ...a, pending: true })
    nodes.push({ ...n, workspaceId: wsIds.has(n.workspaceId) ? n.workspaceId : workspaces[0]!.id, parentId: n.parentId && groupNode.has(n.parentId) ? n.parentId : null })
  }
  const squadIds = new Set(squads.map((q) => q.id))
  const exists = (e: { kind: string; id: string }) => (e.kind === 'agent' ? agentIds.has(e.id) : e.kind === 'group' ? groupIds.has(e.id) : squadIds.has(e.id))
  const edges: SavedEdge[] = s.edges
    .filter((e) => wsIds.has(e.workspaceId) && exists(e.source) && exists(e.target))
    .map((e) => ({ id: e.id, workspaceId: e.workspaceId, source: { ...e.source }, target: { ...e.target }, template: e.template, condition: e.condition, paused: e.paused }))
  return { workspaces, nodes, agents, groups, squads, edges }
}

/** Why a saved agent cannot be relaunched as saved (fields read back from the database are never trusted), or null. */
export function savedAgentProblem(a: SavedAgent): string | null {
  if (!AGENT_NAME_RE.test(a.name) || !isValidRole(a.role)) return 'its saved data is not valid'
  if (!UUID_RE.test(a.sessionId)) return 'its saved session is not valid'
  if (a.model !== null && !(MODEL_CHOICES as readonly string[]).includes(a.model)) return 'its saved model is not valid'
  if (!a.branch.startsWith('agent/') || slotOf(a.branch, a.role) === undefined || !SHA_RE.test(a.base)) return 'its saved branch is not valid'
  if (a.systemPrompt.length > PROMPT_MAX || a.systemPrompt.includes('\0') || !UUID_RE.test(a.id) || (a.presetId !== null && !UUID_RE.test(a.presetId))) return 'its saved data is not valid'
  return null
}

/** `keep`: its record stays on the saved board (a later start tries again); `branch`: so the user can find its worktree. */
export type Skipped = { name: string; reason: string; branch?: string; id?: string; keep?: boolean }
export type RestorePlan = { agents: SavedAgent[]; consoles: SavedNode[]; skipped: Skipped[] }

/**
 * What to relaunch: each agent on the board whose saved data is valid and whose worktree checked out on disk (`problems`: why not,
 * by agent id; absent = fine), then the consoles, within `free` terminals. Everything else is skipped with its reason.
 */
export function planRestore(b: SavedBoard, problems: Map<string, string>, free: number): RestorePlan {
  const onBoard = new Set(b.nodes.filter((n) => n.kind === 'agent').map((n) => n.id))
  const plan: RestorePlan = { agents: [], consoles: [], skipped: [] }
  let left = Math.max(0, free)
  for (const a of b.agents) {
    if (!onBoard.has(a.id)) continue
    const bad = savedAgentProblem(a)
    const name = AGENT_NAME_RE.test(a.name) ? a.name : 'an agent'
    const again = a.pending ? ', again' : ''
    if (bad) plan.skipped.push({ name, reason: bad }) // malformed: dropped
    else if (problems.has(a.id)) plan.skipped.push({ name, branch: a.branch, id: a.id, keep: true, reason: problems.get(a.id)! + again })
    else if (left-- > 0) plan.agents.push(a)
    else plan.skipped.push({ name, branch: a.branch, id: a.id, keep: true, reason: `no terminal was free${again}` })
  }
  for (const n of b.nodes.filter((x) => x.kind === 'console')) {
    if (left-- > 0) plan.consoles.push(n)
    else plan.skipped.push({ name: 'a console', reason: 'no terminal was free' })
  }
  return plan
}

/**
 * The saved board around the terminals that came back (`ids`: saved id -> new id): cards keep their places, groups keep their
 * surviving members (in order) and vanish when none is left, a squad goes with its Orchestrator, and edges that lost an end go.
 */
export function rebuildBoard(b: SavedBoard, ids: Map<string, string>): SavedBoard {
  const cards = b.nodes.filter((n) => (n.kind === 'agent' || n.kind === 'console') && ids.has(n.id))
  const groups = b.groups.filter((g) => cards.some((c) => c.parentId === g.id))
  const groupIds = new Set(groups.map((g) => g.id))
  const squads = b.squads
    .filter((q) => ids.has(q.orchestratorId))
    .map((q) => ({ id: q.id, orchestratorId: ids.get(q.orchestratorId)!, groupIds: q.groupIds.filter((g) => groupIds.has(g)), extraIds: q.extraIds.flatMap((a) => (ids.has(a) ? [ids.get(a)!] : [])) }))
  const squadIds = new Set(squads.map((q) => q.id))
  const parents = new Set([...groupIds, ...squadIds])
  const nodes: SavedNode[] = [
    ...cards.map((c) => ({ ...c, id: ids.get(c.id)!, parentId: c.parentId && parents.has(c.parentId) ? c.parentId : null })),
    ...b.nodes.filter((n) => (n.kind === 'group' && groupIds.has(n.id)) || (n.kind === 'orchestrator' && squadIds.has(n.id))).map((n) => ({ ...n })),
  ]
  const end = <E extends { kind: string; id: string }>(e: E): E | null => (e.kind === 'agent' ? (ids.has(e.id) ? { ...e, id: ids.get(e.id)! } : null) : (e.kind === 'group' ? groupIds : squadIds).has(e.id) ? { ...e } : null)
  const edges = b.edges.flatMap((e) => {
    const source = end(e.source)
    const target = end(e.target)
    return source && target ? [{ ...e, source, target }] : []
  })
  const agents = b.agents.flatMap((a) => (ids.has(a.id) ? [{ ...a, id: ids.get(a.id)! }] : []))
  return { workspaces: b.workspaces.map((w) => ({ ...w, viewport: { ...w.viewport } })), nodes, agents, groups: groups.map((g) => ({ ...g })), squads, edges }
}

/** One line for the user: how many did not come back and why. Names are short agent names; nothing else is quoted. */
export function restoreNotice(skipped: Skipped[], max = 400): string | null {
  if (skipped.length === 0) return null
  const head = `${skipped.length} terminal${skipped.length > 1 ? 's' : ''} did not come back`
  const text = `${head}: ${skipped.map((s) => `${s.name} (${s.branch ? `${s.branch}, ` : ''}${s.reason})`).join(', ')}.`
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const validName = (n: string) => n.trim().length > 0 && n.length <= GROUP_NAME_MAX && !CONTROL_RE.test(n)
const finite = (v: number) => (Number.isFinite(v) ? Math.min(1_000_000, Math.max(-1_000_000, v)) : 0)

/**
 * A board read back from the database, before anything is relaunched: every id must be a UUID and every reference must point at
 * something kept; at most WORKSPACES_MAX workspaces; names, templates, conditions and pause reasons within their limits; agents
 * whose saved data is malformed are dropped (never relaunched, never touched on disk). Whatever is not valid is dropped and counted.
 */
export function sanitizeBoard(b: SavedBoard): { board: SavedBoard; dropped: number } {
  let dropped = 0
  const keep = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter((x) => ok(x) || (dropped++, false))
  const workspaces = keep(b.workspaces, (w) => UUID_RE.test(w.id) && validName(w.name))
    .sort((x, y) => x.order - y.order)
    .slice(0, WORKSPACES_MAX)
    .map((w) => ({ ...w, viewport: { x: finite(w.viewport.x), y: finite(w.viewport.y), zoom: Number.isFinite(w.viewport.zoom) ? Math.min(4, Math.max(0.05, w.viewport.zoom)) : 1 } }))
  const wsIds = new Set(workspaces.map((w) => w.id))
  const agents = keep(b.agents, (a) => savedAgentProblem(a) === null)
  const agentIds = new Set(agents.map((a) => a.id))
  const groups = keep(b.groups, (g) => UUID_RE.test(g.id) && validName(g.name) && (g.presetId === null || UUID_RE.test(g.presetId)))
  const nodes = keep(b.nodes, (n) => UUID_RE.test(n.id) && wsIds.has(n.workspaceId) && (n.kind !== 'agent' || agentIds.has(n.id)) && (n.parentId === null || UUID_RE.test(n.parentId)))
    .map((n) => ({ ...n, x: finite(n.x), y: finite(n.y), w: Math.max(0, finite(n.w)), h: Math.max(0, finite(n.h)) }))
  const squads = keep(b.squads, (q) => UUID_RE.test(q.id) && agentIds.has(q.orchestratorId)).map((q) => ({ ...q, groupIds: q.groupIds.filter((g) => UUID_RE.test(g)), extraIds: q.extraIds.filter((a) => UUID_RE.test(a)) }))
  const edges = keep(
    b.edges,
    (e) =>
      UUID_RE.test(e.id) && wsIds.has(e.workspaceId) && UUID_RE.test(e.source.id) && UUID_RE.test(e.target.id) &&
      e.template.length <= TEMPLATE_MAX && e.template.trim().length > 0 && !e.template.includes('\0') &&
      e.condition.length <= CONDITION_MAX && !CONTROL_RE.test(e.condition) &&
      (e.paused === null || (e.paused.length > 0 && e.paused.length <= REASON_MAX && !CONTROL_RE.test(e.paused))),
  )
  return { board: { workspaces, nodes, agents: agents.filter((a) => nodes.some((n) => n.id === a.id)), groups, squads, edges }, dropped }
}

/** The workspaces whose annotations a layout save may delete: ones the renderer had (was sent or saved itself) and no longer lists. Others are never touched. */
export function staleWorkspaces(known: ReadonlySet<string>, listed: string[]): string[] {
  return [...known].filter((w) => !listed.includes(w))
}

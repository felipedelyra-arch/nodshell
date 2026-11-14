// Pure canvas graph logic (no React, no store): terminal and group nodes, group layout, membership.
import { Position, type Edge, type Node } from '@xyflow/react'
import { SQUAD_GROUP_SIZE, type SquadRole } from '../shared/agent'
import type { ChannelOutput, EventPayload } from '../shared/ipc/channels'

export type AgentState = ChannelOutput<'agent:spawnMany'>['agents'][number]['state']
/** `bypass`: the agent runs with permission bypass (the tag then reads BYPASS); no agent does yet. */
/** `report`: the agent's own status line (MCP report_status). */
export type AgentInfo = { role: string; model: string; branch: string; state: AgentState; statusUnavailable: boolean; bypass?: boolean; report?: string }
/** `workspaceId`: the board the node belongs to (every node carries it, group members included: xyflow lays children out flat). */
export type TerminalData = { ptyId: string; name: string; status: 'running' | 'exited'; startedAt: number; pinned?: boolean; agent?: AgentInfo; workspaceId?: string }
export type GroupData = { name: string; collapsed: boolean; workspaceId?: string }
export type TerminalFlowNode = Node<TerminalData, 'terminal'>
export type GroupFlowNode = Node<GroupData, 'group'>
/** `groups` in display order (Backend, Reviewers, Frontend, Testers, then any role spawn_agent added); the Orchestrator's own terminal is a hidden child card. */
export type OrchestratorData = { orchestratorId: string; groups: { id: string; role: string }[]; workspaceId?: string }
export type OrchestratorFlowNode = Node<OrchestratorData, 'orchestrator'>
/** A live web page: what main reports of it (cleaned title, origin + path, loading, a generic error). */
export type WebTileData = { title: string; address: string; loading: boolean; error: string | null; workspaceId?: string }
export type WebTileFlowNode = Node<WebTileData, 'webtile'>
export type AppNode = TerminalFlowNode | GroupFlowNode | OrchestratorFlowNode | WebTileFlowNode

export const CARD_W = 420
export const CARD_H = 280 // about 1.5:1
export const GAP = 24
/** between cards inside a group: wider than before, as in the reference (the frame itself stays snug, PAD) */
export const IN_GAP = 24
const PAD = 12
export const COLLAPSED = { width: 300, height: 8 }
/** the card resizer's minimum */
export const RESIZE_MIN = { w: 300, h: 180 }

export const isTerminal = (n: AppNode): n is TerminalFlowNode => n.type === 'terminal'
export const isGroup = (n: AppNode): n is GroupFlowNode => n.type === 'group'
export const isOrchestrator = (n: AppNode): n is OrchestratorFlowNode => n.type === 'orchestrator'
export const isWebTile = (n: AppNode): n is WebTileFlowNode => n.type === 'webtile'

/** a web tile: a title bar over a 16:10 page */
export const TILE_HEAD = 30
export const TILE_W = 480
export const TILE_H = TILE_HEAD + 300
export const TILE_MIN = { w: 240, h: TILE_HEAD + 120 }

export function webTileNode(id: string, data: WebTileData, position: { x: number; y: number }, size?: { w: number; h: number }): WebTileFlowNode {
  const fits = size && size.w >= TILE_MIN.w && size.h >= TILE_MIN.h
  return { id, type: 'webtile', dragHandle: '.drag-handle', position, style: { width: fits ? Math.min(size.w, 4000) : TILE_W, height: fits ? Math.min(size.h, 3000) : TILE_H }, data }
}

export const cardNode = (id: string, data: TerminalData, position: { x: number; y: number }): TerminalFlowNode => ({
  id,
  type: 'terminal',
  dragHandle: '.drag-handle',
  position,
  style: { width: CARD_W, height: CARD_H },
  data,
})

/** The process is alive: not exited and not in the error state. */
export function isAlive(d: TerminalData): boolean {
  return d.status === 'running' && d.agent?.state !== 'exited' && d.agent?.state !== 'error'
}

/** The nodes of one workspace (all of them when `ws` is undefined). Board calculations (free slot, squad spot, edges, selection, fit) run on this. */
export const inWorkspace = (nodes: AppNode[], ws?: string): AppNode[] => (ws === undefined ? nodes : nodes.filter((n) => n.data.workspaceId === ws))

/** Nodes of other workspaces stay mounted (their terminals keep running and keep their content) but cannot be seen, hit, selected nor dragged. */
export function hideOtherWorkspaces(nodes: AppNode[], ws: string): AppNode[] {
  return nodes.map((n): AppNode => (n.data.workspaceId === ws ? n : { ...n, selectable: false, draggable: false, style: { ...n.style, visibility: 'hidden', pointerEvents: 'none' } }))
}

/** Terminals main still knows about: a console whose process exited is gone there, so it is only removed from the board. */
export const closableIds = (nodes: AppNode[]): string[] => nodes.filter((n) => isTerminal(n) && (n.data.agent || n.data.status === 'running')).map((n) => n.id)

/** Agents with a live process; each one owns a worktree. */
export const liveAgentCount = (nodes: AppNode[]): number => nodes.filter((n) => isTerminal(n) && n.data.agent && isAlive(n.data)).length

/** One row, left to right, whatever the member count. */
export function memberPosition(i: number): { x: number; y: number } {
  return { x: PAD + i * (CARD_W + IN_GAP), y: PAD }
}

export function groupSize(count: number, collapsed: boolean): { width: number; height: number } {
  if (collapsed) return COLLAPSED
  const n = Math.max(count, 1)
  return { width: PAD * 2 + n * CARD_W + (n - 1) * IN_GAP, height: PAD * 2 + CARD_H }
}

export const membersOf = (nodes: AppNode[], groupId: string): TerminalFlowNode[] => nodes.filter((n): n is TerminalFlowNode => isTerminal(n) && n.parentId === groupId)

export function runningCount(nodes: AppNode[], groupId: string): number {
  return membersOf(nodes, groupId).filter((m) => isAlive(m.data)).length
}

/** Recomputes the group's size and its members' positions and visibility. Collapsed members stay mounted (hidden) so their terminals keep their content. */
export function layoutGroup(nodes: AppNode[], groupId: string): AppNode[] {
  const g = nodes.find((n): n is GroupFlowNode => isGroup(n) && n.id === groupId)
  if (!g) return nodes
  const order = new Map(membersOf(nodes, groupId).map((m, i) => [m.id, i]))
  return nodes.map((n): AppNode => {
    if (n.id === groupId) return { ...n, style: { ...n.style, ...groupSize(order.size, g.data.collapsed) } }
    const i = order.get(n.id)
    if (i === undefined) return n
    // xyflow turns pointer events off for nodes that are neither draggable nor selectable; members need them (buttons, terminal)
    const look = g.data.collapsed ? ({ visibility: 'hidden', pointerEvents: 'none' } as const) : ({ pointerEvents: 'all' } as const)
    return { ...n, position: memberPosition(i), style: { width: CARD_W, height: CARD_H, ...look } }
  })
}

const sizeOf = (n: AppNode) => ({ w: Number(n.style?.width ?? n.width ?? CARD_W), h: Number(n.style?.height ?? n.height ?? CARD_H) })

/** Next free spot: right of the last top-level node, wrapping to a new row below everything. */
export function nextSlot(nodes: AppNode[], w: number, maxRight = 1400): { x: number; y: number } {
  const top = nodes.filter((n) => !n.parentId)
  if (top.length === 0) return { x: GAP, y: 140 }
  const right = Math.max(...top.map((n) => n.position.x + sizeOf(n).w))
  if (right + GAP + w <= maxRight) return { x: right + GAP, y: Math.min(...top.map((n) => n.position.y)) }
  return { x: GAP, y: Math.max(...top.map((n) => n.position.y + sizeOf(n).h)) + 48 }
}

/** Puts `memberIds` (existing top-level cards) into the group, creating it when new (at `origin`, else around the cards). */
export function joinGroup(nodes: AppNode[], g: { id: string; name: string }, memberIds: string[], origin?: { x: number; y: number }): AppNode[] {
  const ids = new Set(memberIds)
  const moving = nodes.filter((n): n is TerminalFlowNode => isTerminal(n) && ids.has(n.id))
  let groupNode = nodes.find((n): n is GroupFlowNode => isGroup(n) && n.id === g.id)
  const rest = nodes.filter((n) => !ids.has(n.id) && n.id !== g.id)
  if (!groupNode) {
    const at = origin ?? { x: Math.min(...moving.map((m) => m.position.x)) - PAD, y: Math.min(...moving.map((m) => m.position.y)) - PAD }
    groupNode = { id: g.id, type: 'group', position: at, selectable: false, zIndex: -1, data: { name: g.name, collapsed: false, workspaceId: moving[0]?.data.workspaceId }, style: groupSize(0, false) }
  }
  const adopted = moving.map((m): TerminalFlowNode => ({ ...m, parentId: g.id, draggable: false, selectable: false, selected: false }))
  const existing = nodes.filter((n) => n.parentId === g.id)
  // parents must come before their children
  return layoutGroup([...rest.filter((n) => n.parentId !== g.id), groupNode, ...existing, ...adopted], g.id)
}

/** Dissolves the group; the cards stay where they are on the canvas. */
export function leaveGroup(nodes: AppNode[], groupId: string): AppNode[] {
  const g = nodes.find((n) => n.id === groupId && isGroup(n))
  if (!g) return nodes
  return nodes
    .filter((n) => n.id !== groupId)
    .map((n): AppNode => {
      if (n.parentId !== groupId) return n
      const free: AppNode = { ...n, position: { x: g.position.x + n.position.x, y: g.position.y + n.position.y }, style: { width: CARD_W, height: CARD_H } }
      delete free.parentId
      if (n.type === 'terminal' && n.data.pinned) free.draggable = false
      else delete free.draggable
      delete free.selectable
      return free
    })
}

/** Removes a card; its group is re-laid out, or removed when this was its last member. */
export function removeCard(nodes: AppNode[], id: string): AppNode[] {
  const parent = nodes.find((n) => n.id === id)?.parentId
  const next = nodes.filter((n) => n.id !== id)
  if (!parent) return next
  return membersOf(next, parent).length === 0 ? next.filter((n) => n.id !== parent) : layoutGroup(next, parent)
}

export function setCollapsed(nodes: AppNode[], groupId: string, collapsed: boolean): AppNode[] {
  return layoutGroup(
    nodes.map((n) => (n.id === groupId && isGroup(n) ? { ...n, data: { ...n.data, collapsed } } : n)),
    groupId,
  )
}

/** Cards that can be grouped now: selected and not in a group yet. */
export const groupableIds = (nodes: AppNode[]): string[] => nodes.filter((n) => isTerminal(n) && n.selected && !n.parentId).map((n) => n.id)

/** Pins or unpins a free card: a pinned card cannot be dragged. Grouped cards are placed by their group, so they are left alone. */
export function setPinned(nodes: AppNode[], id: string, pinned: boolean): AppNode[] {
  return nodes.map((n): AppNode => {
    if (n.id !== id || !isTerminal(n) || n.parentId) return n
    const next: TerminalFlowNode = { ...n, data: { ...n.data, pinned }, draggable: !pinned }
    if (!pinned) delete next.draggable
    return next
  })
}

/** Raises the maximized card above everything else (null puts all back). */
export function raiseOnly(nodes: AppNode[], id: string | null): AppNode[] {
  return nodes.map((n): AppNode => {
    if (!isTerminal(n)) return n
    if (n.id === id) return { ...n, zIndex: 1000 }
    if (n.zIndex === undefined) return n
    const rest = { ...n }
    delete rest.zIndex
    return rest
  })
}

export const ORCH_W = 300 // about a third of a two-card group frame
export const SQUAD_COL_GAP = 200 // room for the group -> Orchestrator edges (the reference leaves more, but a squad must still fit one screen above the semantic-zoom threshold)
const SQUAD_ROW_GAP = 80
/** The Orchestrator node spans both group rows; its panel hugs its content and is centred in it. */
export const ORCH_BAND = 2 * groupSize(SQUAD_GROUP_SIZE, false).height + SQUAD_ROW_GAP
const SQUAD_GAP = 320 // between stacked squads: the centre stays free for other nodes
export const SQUAD_SECTIONS: readonly SquadRole[] = ['backend', 'reviewer', 'frontend', 'tester']

export type SquadSpots = Record<SquadRole | 'orchestrator', { x: number; y: number }>

/** Where a new squad goes: below everything on the board, aligned with the previous squad; existing nodes never move. */
export function squadSpots(nodes: AppNode[]): SquadSpots {
  const g = groupSize(SQUAD_GROUP_SIZE, false)
  const top = nodes.filter((n) => !n.parentId)
  const prev = top.filter(isOrchestrator).at(-1)
  const x = prev ? prev.position.x - g.width - SQUAD_COL_GAP : GAP
  const y = top.length ? Math.max(...top.map((n) => n.position.y + sizeOf(n).h)) + (prev ? SQUAD_GAP : 48) : 140
  const mid = x + g.width + SQUAD_COL_GAP
  const right = mid + ORCH_W + SQUAD_COL_GAP
  const lower = y + g.height + SQUAD_ROW_GAP
  return {
    frontend: { x, y },
    tester: { x, y: lower },
    backend: { x: right, y },
    reviewer: { x: right, y: lower },
    orchestrator: { x: mid, y },
  }
}

export type SquadCreated = ChannelOutput<'squad:create'>
type Spawned = SquadCreated['orchestrator']

const agentCard = (a: Spawned, startedAt: number, position: { x: number; y: number }, workspaceId?: string) =>
  cardNode(a.id, { ptyId: a.id, name: a.name, status: 'running', startedAt, workspaceId, agent: { role: a.role, model: a.model, branch: a.branch, state: a.state, statusUnavailable: a.statusUnavailable } }, position)

/** Adds a created squad: its four groups around the Orchestrator node, which holds the Orchestrator's terminal hidden until expanded. */
export function addSquad(nodes: AppNode[], r: SquadCreated, startedAt: number, ws?: string): AppNode[] {
  const spots = squadSpots(inWorkspace(nodes, ws))
  let next = nodes
  for (const g of r.groups) {
    const cards = g.memberIds.flatMap((id) => r.agents.filter((a) => a.id === id).map((a) => agentCard(a, startedAt, { x: 0, y: 0 }, ws)))
    next = joinGroup([...next, ...cards], g, g.memberIds, spots[g.role])
  }
  return [...next, ...squadNodes(r.squad.id, r.orchestrator, startedAt, spots.orchestrator, r.groups, ws)]
}

/** The Orchestrator node and, docked in it, the Orchestrator's own terminal (hidden until expanded). */
function squadNodes(squadId: string, lead: Spawned, startedAt: number, position: { x: number; y: number }, groups: { id: string; role: string }[], ws?: string): [OrchestratorFlowNode, TerminalFlowNode] {
  // the band itself takes no pointer: the canvas stays usable above and below the panel, which takes them back
  const panel: OrchestratorFlowNode = { id: squadId, type: 'orchestrator', dragHandle: '.drag-handle', position, style: { width: ORCH_W, height: ORCH_BAND, pointerEvents: 'none' }, data: { orchestratorId: lead.id, groups: sections(groups.map(({ id, role }) => ({ id, role }))), workspaceId: ws } }
  // laid out at card size so the CLI keeps a normal width; shown (and given pointer events) only while maximized
  const terminal: TerminalFlowNode = { ...agentCard(lead, startedAt, { x: 0, y: 0 }, ws), parentId: panel.id, draggable: false, selectable: false, style: { width: CARD_W, height: CARD_H, visibility: 'hidden', pointerEvents: 'none' } }
  return [panel, terminal]
}

export type BoardView = NonNullable<ChannelOutput<'board:restore'>['board']>

/**
 * Cards the window already had when a saved board came back (e.g. a console opened before the project): they stay, moved together
 * onto the restored active board at its next free spot. Main keeps running them and saves them there too.
 */
export function keepOnBoard(restored: AppNode[], kept: AppNode[], ws: string): AppNode[] {
  const top = kept.filter((n) => !n.parentId)
  if (top.length === 0) return restored
  const x0 = Math.min(...top.map((n) => n.position.x))
  const y0 = Math.min(...top.map((n) => n.position.y))
  const width = Math.max(...top.map((n) => n.position.x + sizeOf(n).w)) - x0
  const at = nextSlot(inWorkspace(restored, ws), width)
  const moved = kept.map((n): AppNode => ({ ...n, selected: false, data: { ...n.data, workspaceId: ws }, position: n.parentId ? n.position : { x: n.position.x - x0 + at.x, y: n.position.y - y0 + at.y } }) as AppNode)
  return [...restored, ...moved]
}

/** A restored board: cards, groups and Orchestrator nodes back at their saved places (main already dropped what did not come back). */
export function boardNodes(b: BoardView, startedAt: number): AppNode[] {
  const docked = new Set(b.squads.map((s) => s.orchestratorId))
  let nodes: AppNode[] = b.terminals
    .filter((t) => !docked.has(t.id))
    .map((t) => {
      const c = cardNode(t.id, { ptyId: t.id, name: t.name, status: 'running', startedAt, workspaceId: t.workspaceId, ...(t.agent ? { agent: { role: t.agent.role, model: t.agent.model, branch: t.agent.branch, state: t.agent.state, statusUnavailable: t.agent.statusUnavailable } } : {}) }, { x: t.x, y: t.y })
      // a loose card keeps the size it was resized to (a grouped one is laid out by its group)
      return t.w >= RESIZE_MIN.w && t.h >= RESIZE_MIN.h ? { ...c, style: { width: Math.min(t.w, 4000), height: Math.min(t.h, 3000) } } : c
    })
  for (const g of b.groups) {
    const ids = g.memberIds.filter((id) => nodes.some((n) => n.id === id && !n.parentId))
    if (ids.length === 0) continue
    nodes = joinGroup(nodes, g, ids, { x: g.x, y: g.y })
    if (g.collapsed) nodes = setCollapsed(nodes, g.id, true)
  }
  for (const t of b.terminals) if (t.pinned) nodes = setPinned(nodes, t.id, true) // grouped cards are left alone
  for (const s of b.squads) {
    const lead = b.terminals.find((t) => t.id === s.orchestratorId)?.agent
    if (lead) nodes = [...nodes, ...squadNodes(s.id, lead, startedAt, { x: s.x, y: s.y }, s.groups, s.workspaceId)]
  }
  return nodes
}

const rank = (role: string) => {
  const i = SQUAD_SECTIONS.indexOf(role as SquadRole)
  return i < 0 ? SQUAD_SECTIONS.length : i
}
/** The panel's sections: the squad roles in their order, then other roles in the order they came. */
const sections = (groups: { id: string; role: string }[]) => [...groups].sort((a, b) => rank(a.role) - rank(b.role))
const isSquadRole = (role: string): role is SquadRole => (SQUAD_SECTIONS as readonly string[]).includes(role)

/**
 * A card spawn_agent started: it joins its group, whose frame grows along its single row, away from the Orchestrator (a group left
 * of it grows leftwards); a new group takes its role's place beside the Orchestrator (any other role: the next free spot) and
 * becomes a section of the panel. Without its squad on the board it is a loose card.
 */
export function addSpawned(nodes: AppNode[], e: EventPayload<'squad:spawned'>, startedAt: number, fallbackWs?: string): AppNode[] {
  const panel = nodes.find((n): n is OrchestratorFlowNode => isOrchestrator(n) && n.id === e.squadId)
  const ws = panel ? panel.data.workspaceId : fallbackWs
  const c = agentCard(e.agent, startedAt, { x: 0, y: 0 }, ws)
  if (!panel || !e.group) return [...nodes, { ...c, position: nextSlot(inWorkspace(nodes, ws), CARD_W) }]
  const g = e.group
  const frame = nodes.find((n) => n.id === g.id && isGroup(n))
  if (frame) {
    const shift = frame.position.x < panel.position.x ? CARD_W + IN_GAP : 0
    return joinGroup([...nodes, c], g, [c.id]).map((n) => (n.id === g.id && shift ? { ...n, position: { x: n.position.x - shift, y: n.position.y } } : n))
  }
  const one = groupSize(1, false)
  const lower = panel.position.y + groupSize(SQUAD_GROUP_SIZE, false).height + SQUAD_ROW_GAP
  const board = inWorkspace(nodes, ws)
  const home = isSquadRole(g.role)
    ? {
        x: g.role === 'frontend' || g.role === 'tester' ? panel.position.x - SQUAD_COL_GAP - one.width : panel.position.x + ORCH_W + SQUAD_COL_GAP,
        y: g.role === 'frontend' || g.role === 'backend' ? panel.position.y : lower,
      }
    : undefined
  // its role's place beside the Orchestrator only while nothing stands there (e.g. the cards of a group the user dissolved)
  const taken = (p: { x: number; y: number }) =>
    board.some((n) => {
      if (n.parentId) return false
      const s = sizeOf(n)
      return p.x < n.position.x + s.w && n.position.x < p.x + one.width && p.y < n.position.y + s.h && n.position.y < p.y + one.height
    })
  const spot = home && !taken(home) ? home : nextSlot(board, one.width)
  const groups = sections([...panel.data.groups, { id: g.id, role: g.role }])
  return joinGroup([...nodes, c], g, [c.id], spot).map((n): AppNode => (n.id === panel.id && isOrchestrator(n) ? { ...n, data: { ...n.data, groups } } : n))
}

/** Handles of a squad edge: groups on the left leave from their right side, groups on the right from their left; the upper row enters the Orchestrator higher. */
export const SQUAD_HANDLES: Record<SquadRole, { source: string; target: string; side: Position }> = {
  frontend: { source: 'r-lo', target: 'l-hi', side: Position.Right },
  tester: { source: 'r-hi', target: 'l-lo', side: Position.Right },
  backend: { source: 'l-lo', target: 'r-hi', side: Position.Left },
  reviewer: { source: 'l-hi', target: 'r-lo', side: Position.Left },
}

export type FlowEdgeDto = ChannelOutput<'flow:create'>['edge']
export type SourceEnd = FlowEdgeDto['source']
export type TargetEnd = FlowEdgeDto['target']
/** `label`: "<from> to <to>", the name of the edge's dot button; `paused`: by the edge itself or because every flow is paused; `lane`: 1 for the second of a two-way pair, drawn beside the first */
export type FlowEdgeData = { edge: FlowEdgeDto; label: string; paused: boolean; firing: boolean; lit: boolean; lane: 0 | 1 }
export type FlowFlowEdge = Edge<FlowEdgeData, 'flow'>

/** The Orchestrator's own card lives inside its node: on the board, it is that node. */
const dockedIn = (nodes: AppNode[], n: AppNode): OrchestratorFlowNode | undefined => {
  const p = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined
  return p && isOrchestrator(p) ? p : undefined
}

/** The flow end a node stands for: an agent card, a group or an Orchestrator node (a console never connects). */
export function endpointOf(nodes: AppNode[], id: string): SourceEnd | TargetEnd | null {
  const n = nodes.find((x) => x.id === id)
  if (!n) return null
  if (isGroup(n)) return { kind: 'group', id: n.id }
  if (isOrchestrator(n)) return { kind: 'squad', id: n.id }
  if (!isTerminal(n) || !n.data.agent) return null
  const dock = dockedIn(nodes, n)
  return dock ? { kind: 'squad', id: dock.id } : { kind: 'agent', id: n.id }
}

/** The node an end is drawn on (an agent docked in its Orchestrator node: that node). */
function nodeOf(nodes: AppNode[], end: SourceEnd | TargetEnd): AppNode | undefined {
  const n = nodes.find((x) => x.id === end.id)
  return n && (dockedIn(nodes, n) ?? n)
}

export function endName(n: AppNode): string {
  if (isGroup(n)) return n.data.name.toUpperCase()
  if (isOrchestrator(n)) return 'Orchestrator'
  if (isWebTile(n)) return n.data.title || n.data.address
  return n.data.name
}

const centreX = (nodes: AppNode[], n: AppNode) => {
  const parent = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined
  return (parent?.position.x ?? 0) + n.position.x + sizeOf(n).w / 2
}

/**
 * The edges of the board, from main's state: a squad group leaves from its side facing the Orchestrator (SQUAD_HANDLES);
 * any other edge leaves the side facing its target. An edge whose ends are not on this board is not drawn.
 * The paths are hidden from assistive tech; each edge's dot is a button (see FlowEdge).
 */
export function flowEdges(nodes: AppNode[], edges: FlowEdgeDto[], s: { flowsPaused: boolean; firing: Record<string, number>; lit: Record<string, number> }): FlowFlowEdge[] {
  return edges.flatMap((e, i): FlowFlowEdge[] => {
    const from = nodeOf(nodes, e.source)
    const to = nodeOf(nodes, e.target)
    if (!from || !to) return []
    const role = isOrchestrator(to) && isGroup(from) ? to.data.groups.find((g) => g.id === from.id)?.role : undefined
    const squadRole = role !== undefined && isSquadRole(role) ? role : undefined
    const rightward = centreX(nodes, to) >= centreX(nodes, from)
    const [sourceHandle, targetHandle] = squadRole ? [SQUAD_HANDLES[squadRole].source, SQUAD_HANDLES[squadRole].target] : rightward ? ['r', 'l'] : ['l', 'r']
    return [
      {
        id: e.id,
        type: 'flow',
        source: from.id,
        target: to.id,
        sourceHandle,
        targetHandle,
        selectable: false,
        focusable: false,
        deletable: false,
        domAttributes: { 'aria-hidden': true },
        data: { edge: e, label: `${endName(from)} to ${endName(to)}`, paused: e.paused !== null || s.flowsPaused, firing: e.id in s.firing, lit: e.id in s.lit, lane: edges.slice(0, i).some((x) => x.source.id === e.target.id && x.target.id === e.source.id) ? 1 : 0 },
      },
    ]
  })
}

/** Keyboard alternative to dragging: where a source can still connect to on its board (not itself, not twice, never a console). */
export function destinations(nodes: AppNode[], source: SourceEnd, edges: FlowEdgeDto[]): { label: string; target: TargetEnd }[] {
  const taken = new Set(edges.filter((e) => e.source.kind === source.kind && e.source.id === source.id).map((e) => `${e.target.kind}:${e.target.id}`))
  return nodes.flatMap((n) => {
    const t = endpointOf(nodes, n.id)
    if (!t || (isTerminal(n) && dockedIn(nodes, n)) || (t.kind === source.kind && t.id === source.id) || taken.has(`${t.kind}:${t.id}`)) return []
    const lead = isOrchestrator(n) ? nodes.find((x) => x.id === n.data.orchestratorId) : undefined
    const label = isTerminal(n) ? `${n.data.name} (${n.data.agent?.role ?? ''})` : isGroup(n) ? `${endName(n)} group` : `Orchestrator${lead && isTerminal(lead) ? ` (${lead.data.name})` : ''}`
    return [{ label, target: t }]
  })
}

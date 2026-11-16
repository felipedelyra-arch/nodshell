import { applyNodeChanges, type NodeChange, type Viewport } from '@xyflow/react'
import { create } from 'zustand'
import { MAX_LIVE, WORKSPACES_MAX } from '../shared/agent'
import { useAnnotations } from './annotations/store'
import type { ChannelOutput, EventPayload } from '../shared/ipc/channels'
import { addSpawned, addSquad, boardNodes, cardNode as card, keepOnBoard, type BoardView, CARD_W, closableIds, endName, isTerminal, groupableIds, groupSize, inWorkspace, joinGroup, leaveGroup, nextSlot, raiseOnly, removeCard, setCollapsed, setPinned, TILE_W, webTileNode, type WebTileData, type AgentState, type AppNode, type FlowEdgeDto, type SourceEnd, type TargetEnd, type TerminalFlowNode } from './graph'

export type { AgentState, TerminalFlowNode }
/** an edge animates this long after it fired; Connect lights the squad's edges this long */
export const FIRING_MS = 1500
export const LIT_MS = 1200
export type LastMessage = ChannelOutput<'agent:lastMessage'>
export type Toast = { text: string; tone: 'error' | 'info' }
export type TaskSummary = EventPayload<'tasks:changed'>
export type LoopDto = EventPayload<'loop:changed'>['loops'][number]
export type HandoffDto = EventPayload<'handoff:changed'>['handoffs'][number]
/** Only the tasks of squads whose Orchestrator node is still on the board. */
const tasksOn = (tasks: Record<string, TaskSummary>, nodes: AppNode[]) => Object.fromEntries(Object.entries(tasks).filter(([squadId]) => nodes.some((n) => n.id === squadId)))

export const MAX_WORKSPACES = WORKSPACES_MAX
export type Workspace = { id: string; name: string }

type State = {
  nodes: AppNode[]
  /** the card shown large over the canvas, if any */
  maximized: string | null
  toast: Toast | null
  repo: { name: string; branch: string } | null
  /** the boards of the open project; each node belongs to one (`data.workspaceId`) and the others stay mounted, hidden */
  workspaces: Workspace[]
  activeWorkspace: string
  /** the number the next workspace gets; never reused while the project stays open */
  nextWorkspace: number
  /** how many agents the Spawn pill starts */
  spawnCount: number
  /** live-terminal limit from main (settings); Spawn N and the messages follow it */
  liveLimit: number
  setLiveLimit: (n: number) => void
  /** memory of the app and its terminals in bytes, 0 until main reports */
  memoryBytes: number
  /** bumped when new cards appear so the canvas can bring them into view */
  fitTick: number
  /** a saved board is coming back: starting agents or switching project waits */
  restoring: boolean
  /** each workspace's pan and zoom (the active one as of its last move) */
  viewports: Record<string, Viewport>
  /** bumped when the active workspace's viewport must be applied from `viewports` (a restored board) */
  viewTick: number
  setViewport: (workspaceId: string, v: Viewport) => void
  /** at startup: the last project and its saved board, if main reopened them */
  restore: () => Promise<void>
  /** flows, as main reports them: every edge of the window, processes stopped (Pause all), flows paused (Pause all or a guard) */
  edges: FlowEdgeDto[]
  paused: boolean
  flowsPaused: boolean
  /** edges animating (just fired) or lit (Connect), by id */
  firing: Record<string, number>
  lit: Record<string, number>
  /** each squad's tasks, as main reports them, by squad id */
  tasks: Record<string, TaskSummary>
  setTasks: (s: TaskSummary) => void
  /** every loop of the window, as main reports them (at most one per agent) */
  loops: LoopDto[]
  setLoops: (loops: LoopDto[]) => void
  /** every handoff of the window, as main reports them (at most one per outgoing agent) */
  handoffs: HandoffDto[]
  setHandoffs: (handoffs: HandoffDto[]) => void
  /** an Orchestrator's spawn_agent started an agent: its card joins the squad */
  squadSpawned: (e: EventPayload<'squad:spawned'>) => void
  setFlow: (s: EventPayload<'flow:changed'>) => void
  fired: (edgeId: string) => void
  flowPaused: (edgeId: string | null, reason: string) => void
  setReport: (ptyId: string, text: string) => void
  connect: (source: SourceEnd, target: TargetEnd) => Promise<boolean>
  updateEdge: (id: string, patch: { template?: string; condition?: string; paused?: boolean }) => Promise<boolean>
  removeEdge: (id: string) => Promise<boolean>
  connectSquad: (squadId: string) => Promise<void>
  pauseAll: () => Promise<void>
  resumeAll: () => Promise<void>
  setSpawnCount: (n: number) => void
  addConsole: () => Promise<void>
  openRepo: () => Promise<void>
  addWorkspace: () => void
  selectWorkspace: (id: string) => void
  closeWorkspace: () => Promise<void>
  /** closes the selected terminals of the board in view, or all of them when none is selected (one confirmation) */
  closeTerminals: () => Promise<void>
  spawnMany: (presetId: string, count: number) => Promise<boolean>
  /** resolves to an error message, or null when the squad is on the board */
  createSquad: (perGroup: number) => Promise<string | null>
  createGroup: (name: string) => Promise<boolean>
  ungroup: (groupId: string) => Promise<void>
  toggleGroup: (groupId: string, collapsed: boolean) => void
  sendPrompt: (ptyId: string, text: string) => Promise<boolean>
  notify: (text: string, tone: Toast['tone']) => void
  closeNode: (ptyId: string) => Promise<void>
  togglePin: (ptyId: string) => void
  setMaximized: (ptyId: string | null) => void
  markExited: (ptyId: string) => void
  setAgentState: (ptyId: string, state: AgentState, statusUnavailable: boolean) => void
  lastMessage: (ptyId: string) => Promise<LastMessage | null>
  /** a web tile in the active workspace; resolves to an error message, or null when it is on the board */
  addWebTile: (address: string) => Promise<string | null>
  /** resolves to an error message, or null when the tile is going there */
  navigateTile: (id: string, address: string) => Promise<string | null>
  reloadTile: (id: string) => Promise<void>
  closeTile: (id: string) => Promise<void>
  setTileState: (e: EventPayload<'webtile:changed'>) => void
  onNodesChange: (changes: NodeChange<AppNode>[]) => void
}

const closing = new Set<string>() // a close already waiting for its confirmation
// States reported while a multi-agent spawn is still running, before its cards exist; applied when they are added.
const early = new Map<string, { state: AgentState; statusUnavailable: boolean }>()
const EARLY_MAX = 64

/** Cards just added take the latest state their agent reported meanwhile. */
function withEarly(nodes: AppNode[]): AppNode[] {
  if (early.size === 0) return nodes
  return nodes.map((n) => {
    const e = n.type === 'terminal' && n.data.agent ? early.get(n.id) : undefined
    if (!e || n.type !== 'terminal' || !n.data.agent) return n
    early.delete(n.id)
    return { ...n, data: { ...n.data, agent: { ...n.data.agent, ...e } } }
  })
}
// The latest state main reported of each web tile, also before its node exists (it starts loading before create answers).
const tileStates = new Map<string, EventPayload<'webtile:changed'>>()
const TILE_STATES_MAX = 16
const tileData = (id: string, d: WebTileData): WebTileData => {
  const e = tileStates.get(id)
  return e ? { ...d, title: e.title, address: e.address, loading: e.loading, error: e.error } : d
}
type RestoredTiles = ChannelOutput<'board:restore'>['webTiles']
const tileNodes = (ts: RestoredTiles): AppNode[] =>
  ts.map((t) => webTileNode(t.id, tileData(t.id, { title: t.title, address: t.address, loading: true, error: null, workspaceId: t.workspaceId }), { x: t.x, y: t.y }, { w: t.w, h: t.h }))
// the id is also the board's key in main (a preset's group is per workspace) and never repeats, so a saved viewport never lands on a later workspace
const freshWorkspace = (n: number): Workspace => ({ id: crypto.randomUUID(), name: `Workspace ${n}` })

/** The whole canvas state for a restored board (its edges also arrive with flow:changed). */
function fromBoard(b: BoardView, viewTick: number, kept: AppNode[], webTiles: RestoredTiles) {
  const nums = b.workspaces.map((w) => Number(/^Workspace (\d{1,3})$/.exec(w.name)?.[1] ?? 0))
  return {
    nodes: withEarly(keepOnBoard([...boardNodes(b, Date.now()), ...tileNodes(webTiles)], raiseOnly(kept, null), b.active)),
    maximized: null,
    workspaces: b.workspaces.map(({ id, name }) => ({ id, name })),
    activeWorkspace: b.active,
    nextWorkspace: Math.max(b.workspaces.length, ...nums) + 1,
    viewports: Object.fromEntries(b.workspaces.map((w) => [w.id, w.viewport])),
    viewTick: viewTick + 1,
    edges: b.edges,
    tasks: {},
  }
}

/** One toast for what a batch close left behind, in the words of the single close. */
function leftBehind(r: { kept: number; archived: number }): string | null {
  const parts = [r.kept > 0 && `${r.kept} agent worktree${r.kept > 1 ? 's' : ''} with uncommitted work kept`, r.archived > 0 && `${r.archived} agent branch${r.archived > 1 ? 'es' : ''} with commits kept`].filter(Boolean)
  return parts.length ? `${parts.join('; ')}.` : null
}
let busyBoard = false // a workspace close or a project switch is waiting for its confirmation
let toastTimer: ReturnType<typeof setTimeout> | undefined
const flashTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Main only ever sends short, path-free messages; strip Electron's "Error invoking remote method" prefix. */
export function remoteMessage(e: unknown, fallback: string): string {
  const m = e instanceof Error ? /Error: ([^:]{1,120})$/.exec(e.message)?.[1] : undefined
  return m ? `${m}.` : fallback
}

export const useCanvas = create<State>((set, get) => {
  const show = (text: string, tone: Toast['tone']) => {
    clearTimeout(toastTimer)
    set({ toast: { text, tone } })
    toastTimer = setTimeout(() => set({ toast: null }), tone === 'error' ? 8000 : 6000)
  }

  const first = freshWorkspace(1)
  /** The workspace a result belongs to: the one active when the request started, unless it was closed meanwhile. */
  const target = (ws: string) => (get().workspaces.some((w) => w.id === ws) ? ws : get().activeWorkspace)
  /** Leaving a board: nothing stays maximized or selected there. */
  const leaving = (s: State, to: string) => ({
    activeWorkspace: to,
    maximized: null,
    nodes: raiseOnly(s.nodes, null).map((n): AppNode => (n.selected ? { ...n, selected: false } : n)),
  })
  /** Marks edges as firing or lit for `ms`; a new mark restarts the time. */
  const flash = (key: 'firing' | 'lit', ids: string[], ms: number) => {
    for (const id of ids) {
      clearTimeout(flashTimers.get(`${key}:${id}`))
      flashTimers.set(
        `${key}:${id}`,
        setTimeout(() => {
          flashTimers.delete(`${key}:${id}`)
          set((s) => {
            const rest = { ...s[key] }
            delete rest[id]
            return { [key]: rest }
          })
        }, ms),
      )
    }
    set((s) => ({ [key]: { ...s[key], ...Object.fromEntries(ids.map((id) => [id, Date.now()])) } }))
  }
  const upsert = (edges: FlowEdgeDto[]) => set((s) => ({ edges: [...s.edges.filter((e) => !edges.some((x) => x.id === e.id)), ...edges] }))

  return {
    nodes: [],
    maximized: null,
    toast: null,
    repo: null,
    workspaces: [first],
    activeWorkspace: first.id,
    nextWorkspace: 2,
    spawnCount: 4,
    liveLimit: MAX_LIVE,
    memoryBytes: 0,
    setLiveLimit: (n) => set((s) => ({ liveLimit: n, spawnCount: Math.min(s.spawnCount, n) })),
    fitTick: 0,
    restoring: false,
    viewports: {},
    viewTick: 0,
    edges: [],
    paused: false,
    flowsPaused: false,
    firing: {},
    lit: {},
    tasks: {},
    loops: [],
    handoffs: [],

    setSpawnCount: (n) => set({ spawnCount: Math.min(get().liveLimit, Math.max(1, Math.trunc(n))) }),

    addConsole: async () => {
      const from = get().activeWorkspace
      try {
        const { id, name } = await window.api.invoke('pty:spawn', { cols: 80, rows: 24 })
        const ws = target(from)
        set((s) => ({ nodes: [...s.nodes, card(id, { ptyId: id, name, status: 'running', startedAt: Date.now(), workspaceId: ws }, nextSlot(inWorkspace(s.nodes, ws), CARD_W))] }))
      } catch (e) {
        show(e instanceof Error && /limit/i.test(e.message) ? `Terminal limit reached (${get().liveLimit}).` : remoteMessage(e, 'Could not start a terminal.'), 'error')
      }
    },

    openRepo: async () => {
      if (busyBoard) return void (get().restoring && show('Wait for the board to finish restoring.', 'info'))
      busyBoard = true
      try {
        // with a project already open, main ends everything of the window (one question) before it switches
        set({ restoring: true }) // main may bring the project's saved board back
        const { repo, changed, kept, archived, board, annotations, webTiles, notice } = await window.api.invoke('workspace:pickRepo', undefined)
        // the cards main still runs stay: all of them when no project was open, none after a switch (main ended them, web tiles too)
        if (board) {
          set((s) => ({ repo, ...fromBoard(board, s.viewTick, changed ? [] : s.nodes, webTiles) }))
          useAnnotations.getState().load(annotations)
        } else if (changed) {
          const w = freshWorkspace(1)
          set({ repo, nodes: [], maximized: null, workspaces: [w], activeWorkspace: w.id, nextWorkspace: 2, tasks: {} })
          useAnnotations.getState().load([]) // the other project's drawings are saved with it
        } else set({ repo })
        const note = notice ?? leftBehind({ kept, archived })
        if (note) show(note, 'info')
      } catch (e) {
        show(remoteMessage(e, 'Could not open the folder.'), 'error')
      } finally {
        busyBoard = false
        set({ restoring: false })
      }
    },

    restore: async () => {
      if (busyBoard) return
      busyBoard = true
      set({ restoring: true })
      try {
        const { repo, board, annotations, webTiles, notice } = await window.api.invoke('board:restore', undefined)
        if (repo) set({ repo })
        if (board) {
          set((s) => fromBoard(board, s.viewTick, s.nodes, webTiles))
          useAnnotations.getState().load(annotations)
        }
        if (notice) show(notice, 'info')
      } catch (e) {
        show(remoteMessage(e, 'Could not restore the board.'), 'error')
      } finally {
        busyBoard = false
        set({ restoring: false })
      }
    },

    setViewport: (ws, v) => set((s) => ({ viewports: { ...s.viewports, [ws]: { x: v.x, y: v.y, zoom: v.zoom } } })),

    addWorkspace: () => {
      const s = get()
      if (!s.repo || s.workspaces.length >= MAX_WORKSPACES) return
      const w = freshWorkspace(s.nextWorkspace)
      set({ workspaces: [...s.workspaces, w], nextWorkspace: s.nextWorkspace + 1, ...leaving(s, w.id) })
    },

    selectWorkspace: (id) => {
      const s = get()
      if (id !== s.activeWorkspace && s.workspaces.some((w) => w.id === id)) set(leaving(s, id))
    },

    closeWorkspace: async () => {
      if (busyBoard) return
      busyBoard = true
      try {
        const s = get()
        const ws = s.activeWorkspace
        const ids = closableIds(inWorkspace(s.nodes, ws))
        if (ids.length > 0) {
          const { closed, kept, archived } = await window.api.invoke('workspace:closeTerminals', { ids })
          if (!closed) return // the user chose to keep them running
          const note = leftBehind({ kept, archived })
          if (note) show(note, 'info')
        }
        useAnnotations.getState().dropWorkspace(ws) // its drawings and image files go with it
        for (const n of inWorkspace(get().nodes, ws)) if (n.type === 'webtile') void window.api.invoke('webtile:close', { id: n.id }).catch(() => undefined) // and its pages
        set((c) => {
          const nodes = c.nodes.filter((n) => n.data.workspaceId !== ws)
          const i = c.workspaces.findIndex((w) => w.id === ws)
          const rest = c.workspaces.filter((w) => w.id !== ws)
          const tasks = tasksOn(c.tasks, nodes)
          if (rest.length === 0) {
            const w = freshWorkspace(1) // there is always one board
            return { nodes, maximized: null, workspaces: [w], activeWorkspace: w.id, nextWorkspace: 2, tasks }
          }
          const next = rest[Math.min(i, rest.length - 1)]!
          return { workspaces: rest, tasks, ...leaving({ ...c, nodes }, next.id) }
        })
      } catch (e) {
        show(remoteMessage(e, 'Could not close the workspace.'), 'error')
      } finally {
        busyBoard = false
      }
    },

    closeTerminals: async () => {
      if (busyBoard) return
      busyBoard = true
      try {
        const s = get()
        const cards = inWorkspace(s.nodes, s.activeWorkspace).filter(isTerminal)
        const picked = cards.filter((n) => n.selected)
        const going = picked.length > 0 ? picked : cards
        const ids = closableIds(going)
        if (ids.length > 0) {
          const { closed, kept, archived } = await window.api.invoke('workspace:closeTerminals', { ids })
          if (!closed) return // the user chose to keep them running
          const note = leftBehind({ kept, archived })
          if (note) show(note, 'info')
        }
        const gone = new Set(going.map((n) => n.id))
        set((c) => {
          const max = c.maximized !== null && gone.has(c.maximized)
          let nodes = max ? raiseOnly(c.nodes, null) : c.nodes
          for (const id of gone) nodes = removeCard(nodes, id)
          return { nodes, maximized: max ? null : c.maximized, tasks: tasksOn(c.tasks, nodes) }
        })
      } catch (e) {
        show(remoteMessage(e, 'Could not close the terminals.'), 'error')
      } finally {
        busyBoard = false
      }
    },

    spawnMany: async (presetId, count) => {
      const from = get().activeWorkspace
      try {
        const r = await window.api.invoke('agent:spawnMany', { presetId, count, cols: 80, rows: 24, workspaceId: from })
        const startedAt = Date.now()
        const ws = target(from)
        set((s) => {
          const fresh = r.agents.map((a) => card(a.id, { ptyId: a.id, name: a.name, status: 'running', startedAt, workspaceId: ws, agent: { role: a.role, model: a.model, branch: a.branch, state: a.state, statusUnavailable: a.statusUnavailable } }, { x: 0, y: 0 }))
          const origin = s.nodes.some((n) => n.id === r.group.id) ? undefined : nextSlot(inWorkspace(s.nodes, ws), groupSize(fresh.length, false).width)
          return { nodes: withEarly(joinGroup([...s.nodes, ...fresh], r.group, fresh.map((f) => f.id), origin)), fitTick: ws === s.activeWorkspace ? s.fitTick + 1 : s.fitTick }
        })
        if (r.failed > 0) show(`${r.failed} of ${count} agents could not start.`, 'error')
        return true
      } catch (e) {
        show(remoteMessage(e, 'Could not start the agents.'), 'error')
        return false
      }
    },

    createSquad: async (perGroup) => {
      const from = get().activeWorkspace
      try {
        const r = await window.api.invoke('squad:create', { cols: 80, rows: 24, workspaceId: from, perGroup })
        const ws = target(from)
        set((s) => ({ nodes: withEarly(addSquad(s.nodes, r, Date.now(), ws)), fitTick: ws === s.activeWorkspace ? s.fitTick + 1 : s.fitTick }))
        upsert(r.edges)
        if (r.failed > 0) show(`${r.failed} of ${r.failed + r.agents.length} agents could not start.`, 'error')
        return null
      } catch (e) {
        return remoteMessage(e, 'Could not start the squad.')
      }
    },

    createGroup: async (name) => {
      const ids = groupableIds(inWorkspace(get().nodes, get().activeWorkspace))
      if (ids.length < 2) return false
      try {
        const g = await window.api.invoke('group:create', { name, memberIds: ids })
        set((s) => ({ nodes: joinGroup(s.nodes, g, ids), fitTick: s.fitTick + 1 }))
        return true
      } catch (e) {
        show(remoteMessage(e, 'Could not create the group.'), 'error')
        return false
      }
    },

    ungroup: async (groupId) => {
      try {
        await window.api.invoke('group:dissolve', { id: groupId })
        set((s) => ({ nodes: leaveGroup(s.nodes, groupId) }))
      } catch (e) {
        show(remoteMessage(e, 'Could not ungroup.'), 'error')
      }
    },

    toggleGroup: (groupId, collapsed) => set((s) => ({ nodes: setCollapsed(s.nodes, groupId, collapsed) })),

    notify: show,

    sendPrompt: async (ptyId, text) => {
      try {
        await window.api.invoke('agent:prompt', { id: ptyId, text })
        return true
      } catch (e) {
        show(remoteMessage(e, 'Could not send the prompt.'), 'error')
        return false
      }
    },

    closeNode: async (ptyId) => {
      if (closing.has(ptyId)) return
      closing.add(ptyId)
      const node = get().nodes.find((n) => n.id === ptyId)
      const agent = node?.type === 'terminal' ? node.data.agent : undefined
      const remove = () =>
        set((s) => {
          const nodes = removeCard(s.maximized === ptyId ? raiseOnly(s.nodes, null) : s.nodes, ptyId)
          return { nodes, maximized: s.maximized === ptyId ? null : s.maximized, tasks: tasksOn(s.tasks, nodes) }
        })
      try {
        if (!agent) {
          const { closed } = await window.api.invoke('pty:kill', { id: ptyId }).catch(() => ({ closed: true })) // already gone is fine
          if (closed) remove()
          return
        }
        const name = node?.type === 'terminal' ? node.data.name : ptyId
        try {
          const { worktree } = await window.api.invoke('agent:close', { id: ptyId })
          if (worktree === 'cancelled') return // the user chose to keep it running
          remove()
          if (worktree === 'kept') show(`${name}: uncommitted work kept in its worktree on ${agent.branch}.`, 'info')
          if (worktree === 'archived') show(`${name}: commits kept on branch ${agent.branch}.`, 'info')
        } catch (e) {
          remove()
          show(remoteMessage(e, 'Could not close the agent.'), 'error')
        }
      } finally {
        closing.delete(ptyId)
      }
    },

    togglePin: (ptyId) =>
      set((s) => {
        const n = s.nodes.find((x) => x.id === ptyId)
        return n && n.type === 'terminal' ? { nodes: setPinned(s.nodes, ptyId, !n.data.pinned) } : s
      }),

    setMaximized: (ptyId) => set((s) => ({ maximized: ptyId, nodes: raiseOnly(s.nodes, ptyId) })),

    markExited: (ptyId) =>
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === ptyId && n.type === 'terminal' ? { ...n, data: { ...n.data, status: 'exited' as const } } : n)) })),

    setAgentState: (ptyId, state, statusUnavailable) =>
      set((s) => {
        if (!s.nodes.some((n) => n.id === ptyId)) {
          if (early.size >= EARLY_MAX) early.delete(early.keys().next().value!) // oldest first
          early.set(ptyId, { state, statusUnavailable })
          return s
        }
        return {
          nodes: s.nodes.map((n) => (n.id === ptyId && n.type === 'terminal' && n.data.agent ? { ...n, data: { ...n.data, agent: { ...n.data.agent, state, statusUnavailable } } } : n)),
        }
      }),

    lastMessage: async (ptyId) => {
      try {
        return await window.api.invoke('agent:lastMessage', { id: ptyId })
      } catch (e) {
        show(remoteMessage(e, 'Could not read the last message.'), 'error')
        return null
      }
    },

    addWebTile: async (address) => {
      const from = get().activeWorkspace
      try {
        const { tile } = await window.api.invoke('webtile:create', { address, workspaceId: from })
        const ws = target(from)
        set((s) => ({
          nodes: [...s.nodes, webTileNode(tile.id, tileData(tile.id, { title: tile.title, address: tile.address, loading: true, error: null, workspaceId: ws }), nextSlot(inWorkspace(s.nodes, ws), TILE_W))],
          fitTick: ws === s.activeWorkspace ? s.fitTick + 1 : s.fitTick,
        }))
        return null
      } catch (e) {
        return remoteMessage(e, 'Could not open the page.')
      }
    },

    navigateTile: async (id, address) => {
      try {
        await window.api.invoke('webtile:navigate', { id, address })
        return null
      } catch (e) {
        return remoteMessage(e, 'Could not open the page.')
      }
    },

    reloadTile: async (id) => {
      try {
        await window.api.invoke('webtile:reload', { id })
      } catch (e) {
        show(remoteMessage(e, 'Could not reload the page.'), 'error')
      }
    },

    closeTile: async (id) => {
      await window.api.invoke('webtile:close', { id }).catch(() => undefined) // already gone is fine
      tileStates.delete(id)
      set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id) }))
    },

    setTileState: (e) => {
      tileStates.delete(e.id)
      if (tileStates.size >= TILE_STATES_MAX) tileStates.delete(tileStates.keys().next().value!) // oldest first
      tileStates.set(e.id, e)
      set((s) => (s.nodes.some((n) => n.id === e.id) ? { nodes: s.nodes.map((n) => (n.id === e.id && n.type === 'webtile' ? { ...n, data: tileData(n.id, n.data) } : n)) } : s))
    },

    onNodesChange: (changes) => set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) })),

    setTasks: (t) => set((s) => ({ tasks: { ...s.tasks, [t.squadId]: t } })),
    setLoops: (loops) => set({ loops }),
    setHandoffs: (handoffs) => set({ handoffs }),
    squadSpawned: (e) => set((s) => ({ nodes: withEarly(addSpawned(s.nodes, e, Date.now(), e.workspaceId && s.workspaces.some((w) => w.id === e.workspaceId) ? e.workspaceId : s.activeWorkspace)) })),

    setFlow: ({ edges, paused, flowsPaused }) => set({ edges, paused, flowsPaused }),
    fired: (id) => flash('firing', [id], FIRING_MS),
    flowPaused: (edgeId, reason) => {
      const e = get().edges.find((x) => x.id === edgeId)
      const end = (id: string) => get().nodes.find((n) => n.id === id)
      const name = (id: string) => {
        const n = end(id)
        return !n ? 'a card' : endName(n)
      }
      show(e ? `Edge ${name(e.source.id)} to ${name(e.target.id)} paused. ${reason}.` : `${reason}.`, 'error')
    },
    setReport: (ptyId, text) =>
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === ptyId && n.type === 'terminal' && n.data.agent ? { ...n, data: { ...n.data, agent: { ...n.data.agent, report: text } } } : n)) })),

    connect: async (source, target) => {
      try {
        const { edge } = await window.api.invoke('flow:create', { source, target })
        upsert([edge])
        return true
      } catch (e) {
        show(remoteMessage(e, 'Could not connect.'), 'error')
        return false
      }
    },

    updateEdge: async (id, patch) => {
      try {
        const { edge } = await window.api.invoke('flow:update', { id, ...patch })
        upsert([edge])
        return true
      } catch (e) {
        show(remoteMessage(e, 'Could not update the edge.'), 'error')
        return false
      }
    },

    removeEdge: async (id) => {
      try {
        await window.api.invoke('flow:remove', { id })
        set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }))
        return true
      } catch (e) {
        show(remoteMessage(e, 'Could not remove the edge.'), 'error')
        return false
      }
    },

    connectSquad: async (squadId) => {
      try {
        const { edges } = await window.api.invoke('squad:connect', { id: squadId })
        upsert(edges)
        flash('lit', edges.map((e) => e.id), LIT_MS)
      } catch (e) {
        show(remoteMessage(e, 'Could not connect the squad.'), 'error')
      }
    },

    pauseAll: async () => {
      try {
        await window.api.invoke('flow:pauseAll', undefined)
      } catch (e) {
        show(remoteMessage(e, 'Could not pause.'), 'error')
      }
    },

    resumeAll: async () => {
      try {
        await window.api.invoke('flow:resumeAll', undefined)
      } catch (e) {
        show(remoteMessage(e, 'Could not resume.'), 'error')
      }
    },
  }
})

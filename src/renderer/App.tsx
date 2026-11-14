import { Background, BackgroundVariant, ConnectionMode, ReactFlow, ReactFlowProvider, useReactFlow, type FinalConnectionState, type Viewport } from '@xyflow/react'
import { forwardRef, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { HandoffDialog } from './agent/HandoffDialog'
import { SpawnPopover } from './agent/SpawnPopover'
import { AnnotationLayer } from './annotations/Layer'
import { DrawingOverlay } from './annotations/Overlay'
import { useAnnotations } from './annotations/store'
import { FIT_PADDING, Toolbar } from './chrome/Toolbar'
import { GroupNode } from './group/GroupNode'
import { GroupPopover } from './group/GroupPopover'
import { OrchestratorNode } from './orchestrator/OrchestratorNode'
import { FlowEdge } from './flow/FlowEdge'
import { endpointOf, flowEdges, groupableIds, hideOtherWorkspaces, inWorkspace, isAlive, isTerminal } from './graph'
import { PresetsDialog } from './presets/PresetsDialog'
import { usePresets } from './presets/store'
import { useCanvas } from './store'
import { startBus } from './terminal/bus'
import { TerminalNode } from './terminal/TerminalNode'
import { BugDialog } from './chrome/InfoDialogs'
import { MemoryDialog } from './chrome/MemoryDialog'
import { startLayoutSaver } from './board/layout'
import { CommandBar } from './chrome/CommandBar'
import { BugButton, RepoFooter } from './chrome/Footer'
import { TopBar, TopRight } from './TopBar'
import { WebTileNode } from './webtile/WebTileNode'

const nodeTypes = { terminal: TerminalNode, group: GroupNode, orchestrator: OrchestratorNode, webtile: WebTileNode }
const edgeTypes = { flow: FlowEdge }
const PAUSED_TIP = 'Everything is paused, resume all first'

/** Brings new cards into view; lives inside the provider to reach the viewport. */
function FitOnSpawn() {
  const tick = useCanvas((s) => s.fitTick)
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (tick === 0) return
    // only the board in view: the other workspaces' nodes are hidden, not gone
    const { nodes, activeWorkspace } = useCanvas.getState()
    const t = setTimeout(() => void fitView({ nodes: inWorkspace(nodes, activeWorkspace), duration: 0, padding: FIT_PADDING, maxZoom: 1 }), 80) // after the new nodes are measured
    return () => clearTimeout(t)
  }, [tick, fitView])
  return null
}

/** Each workspace keeps its own pan and zoom: saved when leaving it, restored on return (a new one starts at the origin, a restored one where it was). */
function WorkspaceViewport() {
  const active = useCanvas((s) => s.activeWorkspace)
  const tick = useCanvas((s) => s.viewTick)
  const { getViewport, setViewport } = useReactFlow()
  const prev = useRef(active)
  const prevTick = useRef(tick)
  useEffect(() => {
    if (prev.current === active && prevTick.current === tick) return
    if (prevTick.current === tick) useCanvas.getState().setViewport(prev.current, getViewport()) // a restored board brings its own
    prev.current = active
    prevTick.current = tick
    void setViewport(useCanvas.getState().viewports[active] ?? { x: 0, y: 0, zoom: 1 })
  }, [active, tick, getViewport, setViewport])
  return null
}

type PillProps = { children: ReactNode; onClick: () => void; hue: number; tip?: string; popup?: 'dialog'; expanded?: boolean }

/** A bar pill. With `tip` it is visibly and semantically disabled, and the tip says why. */
const Pill = forwardRef<HTMLButtonElement, PillProps>(function Pill({ children, onClick, hue, tip, popup, expanded }, ref) {
  const tipId = useId()
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`pill pill-h${hue} pointer-events-auto`}
        aria-disabled={tip ? true : popup ? false : undefined}
        aria-haspopup={popup}
        aria-expanded={popup ? expanded : undefined}
        aria-describedby={tip ? tipId : undefined}
        data-tip={tip}
        onClick={() => !tip && onClick()}
      >
        {children}
      </button>
      {tip && (
        <span id={tipId} className="sr-only">
          {tip}
        </span>
      )}
    </>
  )
})

export function App() {
  return (
    <ReactFlowProvider>
      <Workbench />
    </ReactFlowProvider>
  )
}

function Workbench() {
  const allNodes = useCanvas((s) => s.nodes)
  const active = useCanvas((s) => s.activeWorkspace)
  const toast = useCanvas((s) => s.toast)
  const repo = useCanvas((s) => s.repo)
  const spawnCount = useCanvas((s) => s.spawnCount)
  const onNodesChange = useCanvas((s) => s.onNodesChange)
  const addConsole = useCanvas((s) => s.addConsole)
  const flowEdgeList = useCanvas((s) => s.edges)
  const flowsPaused = useCanvas((s) => s.flowsPaused)
  const paused = useCanvas((s) => s.paused)
  const firing = useCanvas((s) => s.firing)
  const lit = useCanvas((s) => s.lit)
  const restoring = useCanvas((s) => s.restoring)
  // one briefing at a time: the first that is ready opens its dialog
  const handoff = useCanvas((s) => s.handoffs.find((h) => h.state === 'ready'))
  const board = useMemo(() => inWorkspace(allNodes, active), [allNodes, active])
  const nodes = useMemo(() => hideOtherWorkspaces(allNodes, active), [allNodes, active])
  const selectedCount = groupableIds(board).length
  const edges = useMemo(() => flowEdges(board, flowEdgeList, { flowsPaused, firing, lit }), [board, flowEdgeList, flowsPaused, firing, lit])
  const anyAlive = allNodes.some((n) => isTerminal(n) && isAlive(n.data))
  /** Drag from a card's or group's side onto another card, group or Orchestrator node of this board. */
  const connectNodes = (fromId: string, toId: string) => {
    const source = endpointOf(board, fromId)
    const target = endpointOf(board, toId)
    if (source && target && source.kind !== 'squad' && fromId !== toId) void useCanvas.getState().connect({ kind: source.kind, id: source.id }, target)
  }
  // a drop on the node itself (not on its small handle) also connects
  const onConnectEnd = (e: MouseEvent | TouchEvent, st: FinalConnectionState) => {
    if (st.isValid || !st.fromNode) return
    const p = 'changedTouches' in e ? e.changedTouches[0] : e
    const to = p && document.elementFromPoint(p.clientX, p.clientY)?.closest('.react-flow__node')?.getAttribute('data-id')
    if (to) connectNodes(st.fromNode.id, to)
  }
  const [open, setOpen] = useState<'spawn' | 'group' | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const spawnBtn = useRef<HTMLButtonElement>(null)
  const groupBtn = useRef<HTMLButtonElement>(null)
  const presetsBtn = useRef<HTMLButtonElement>(null)
  const bugBtn = useRef<HTMLButtonElement>(null)
  const [bugOpen, setBugOpen] = useState(false)
  const memoryBtn = useRef<HTMLButtonElement>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const bar = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.invoke('settings:get', undefined).then((r) => useCanvas.getState().setLiveLimit(r.liveLimit), () => undefined)
    return window.api.on('app:memory', ({ bytes }) => useCanvas.setState({ memoryBytes: bytes }))
  }, [])
  useEffect(() => startBus((id) => useCanvas.getState().markExited(id)), [])
  useEffect(() => window.api.on('agent:state', ({ id, state, statusUnavailable }) => useCanvas.getState().setAgentState(id, state, statusUnavailable)), [])
  useEffect(() => {
    const offs = [
      window.api.on('flow:changed', (s) => useCanvas.getState().setFlow(s)),
      window.api.on('flow:fired', ({ id }) => useCanvas.getState().fired(id)),
      window.api.on('flow:paused', ({ id, reason }) => useCanvas.getState().flowPaused(id, reason)),
      window.api.on('agent:report', ({ id, text }) => useCanvas.getState().setReport(id, text)),
      window.api.on('tasks:changed', (t) => useCanvas.getState().setTasks(t)),
      window.api.on('loop:changed', ({ loops }) => useCanvas.getState().setLoops(loops)),
      // a loop ended or paused by itself: the same toast as an edge a guard paused
      window.api.on('loop:notice', ({ text }) => useCanvas.getState().notify(`${text}.`, 'info')),
      window.api.on('handoff:changed', ({ handoffs, notice }) => {
        useCanvas.getState().setHandoffs(handoffs)
        if (notice) useCanvas.getState().notify(`${notice}.`, 'info')
      }),
      window.api.on('squad:spawned', (e) => useCanvas.getState().squadSpawned(e)),
      window.api.on('webtile:changed', (e) => useCanvas.getState().setTileState(e)),
      // F6 in a page: main gave the focus back to this window; it lands on that tile
      window.api.on('webtile:returned', ({ id }) => document.querySelector<HTMLElement>(`[data-tile-body="${CSS.escape(id)}"]`)?.focus()),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  useEffect(() => void usePresets.getState().load(), [])
  useEffect(() => startLayoutSaver(), [])
  useEffect(() => void useCanvas.getState().restore(), [])
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as globalThis.Node)) setOpen(null)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEffect(() => {
    if (open === 'group' && selectedCount < 2) setOpen(null) // the selection it was for is gone
  }, [open, selectedCount])
  const opener = useRef<HTMLElement | null>(null) // what opened the Spawn popover: focus goes back there
  const closePopover = (btn: React.RefObject<HTMLButtonElement | null>) => () => {
    setOpen(null)
    const back = opener.current?.isConnected ? opener.current : btn.current
    opener.current = null
    back?.focus()
  }
  const spawnTip = !repo ? 'Open a repository first' : restoring ? 'Wait for the board to finish restoring' : paused ? PAUSED_TIP : undefined

  return (
    <main className="relative h-screen w-screen" aria-label="Agent Canvas">
      <h1 className="sr-only">Agent Canvas</h1>
      <TopBar />
      <TopRight />
      <div role="tabpanel" id="board" aria-labelledby={`tab-${active}`} className="absolute inset-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          edgesFocusable={false}
          edgesReconnectable={false}
          onNodesChange={onNodesChange}
          onPaneClick={() => useAnnotations.getState().select(null)}
          onMoveEnd={(_e, v: Viewport) => useCanvas.getState().setViewport(active, v)}
          connectionMode={ConnectionMode.Loose}
          isValidConnection={(c) => c.source !== c.target}
          onConnect={(c) => connectNodes(c.source, c.target)}
          onConnectEnd={onConnectEnd}
          connectionLineStyle={{ stroke: '#ff6a2b', strokeWidth: 1.5 }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={0.2}
          maxZoom={2}
          // keys belong to the focused terminal, never to the canvas; Shift only adds to the selection (click or box)
          deleteKeyCode={null}
          panActivationKeyCode={null}
          selectionKeyCode="Shift"
          multiSelectionKeyCode="Shift"
          disableKeyboardA11y
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="#3a3a43" />
          <FitOnSpawn />
          <WorkspaceViewport />
          <AnnotationLayer />
          <DrawingOverlay />
        </ReactFlow>
      </div>
      {board.length === 0 && (
        <p className="pointer-events-none absolute inset-0 z-10 grid place-items-center font-mono text-xs text-muted">
          No terminals yet. Use New console, or open a repository to start agents.
        </p>
      )}
      <Toolbar
        agentTip={spawnTip}
        agentOpen={open === 'spawn'}
        onAgent={(btn) => {
          opener.current = btn
          setOpen(open === 'spawn' ? null : 'spawn')
        }}
      />
      <RepoFooter />
      <div data-chrome="bottom" className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2">
        {toast && (
          <p
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto max-w-lg rounded-md border border-white/10 bg-surface px-3 py-1 text-xs text-text"
          >
            {toast.text}
          </p>
        )}
        <div ref={bar} className="relative flex gap-2">
          {open === 'spawn' && <SpawnPopover onClose={closePopover(spawnBtn)} />}
          {open === 'group' && <GroupPopover onClose={closePopover(groupBtn)} />}
          <Pill hue={0} tip={paused ? PAUSED_TIP : undefined} onClick={() => void addConsole()}>
            New console
          </Pill>
          <Pill hue={1} ref={spawnBtn} popup="dialog" expanded={open === 'spawn'} tip={spawnTip} onClick={() => {
            opener.current = null
            setOpen(open === 'spawn' ? null : 'spawn')
          }}>
            Spawn {spawnCount}
          </Pill>
          <Pill hue={2} ref={groupBtn} popup="dialog" expanded={open === 'group'} tip={selectedCount >= 2 ? undefined : 'Select two or more cards first (Shift+click)'} onClick={() => setOpen(open === 'group' ? null : 'group')}>
            Group
          </Pill>
          <Pill
            hue={3}
            ref={presetsBtn}
            popup="dialog"
            expanded={presetsOpen}
            onClick={() => {
              setOpen(null)
              setPresetsOpen(true)
            }}
          >
            Presets
          </Pill>
          <Pill hue={4} tip={paused ? 'Everything is already paused' : anyAlive ? undefined : 'Nothing is running'} onClick={() => void useCanvas.getState().pauseAll()}>
            Pause all
          </Pill>
          <Pill hue={5} tip={paused || flowsPaused ? undefined : 'Nothing is paused'} onClick={() => void useCanvas.getState().resumeAll()}>
            Resume all
          </Pill>
          <Pill
            hue={6}
            ref={memoryBtn}
            popup="dialog"
            expanded={memoryOpen}
            onClick={() => {
              setOpen(null)
              setMemoryOpen(true)
            }}
          >
            Memory
          </Pill>
        </div>
        <CommandBar />
      </div>
      <BugButton ref={bugBtn} onClick={() => setBugOpen(true)} />
      {bugOpen && (
        <BugDialog
          onClose={() => {
            setBugOpen(false)
            bugBtn.current?.focus()
          }}
        />
      )}
      {memoryOpen && (
        <MemoryDialog
          onClose={() => {
            setMemoryOpen(false)
            memoryBtn.current?.focus()
          }}
        />
      )}
      {handoff && <HandoffDialog key={handoff.id} handoff={handoff} />}
      {presetsOpen && (
        <PresetsDialog
          onClose={() => {
            setPresetsOpen(false)
            presetsBtn.current?.focus()
          }}
        />
      )}
    </main>
  )
}

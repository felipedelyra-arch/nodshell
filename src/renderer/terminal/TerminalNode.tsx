import { Handle, NodeResizer, Position, useStore, useStoreApi, type NodeProps } from '@xyflow/react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { memo, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { shallow } from 'zustand/shallow'
import { statusPill } from '../../shared/agent'
import { DetailsPopover } from '../agent/DetailsPopover'
import { isAlive } from '../graph'
import { useCanvas, type TerminalFlowNode } from '../store'
import { attach } from './bus'
import { TailPreview } from './TailPreview'

const CHUNK = 32768
const ACK_EVERY = 50_000
const FONT_PX = 11
const DOM_RENDERER = new URLSearchParams(location.search).get('renderer') === 'dom' // set by main in tests only
// semantic zoom: below this the card shows a text preview instead of a terminal; it comes back above LOW_ZOOM + hysteresis so it does not flicker
export const LOW_ZOOM = 0.5
const ZOOM_HYSTERESIS = 0.05
// screen margins left free around a maximized card: top bar, bottom bar, the left toolbar and a little air
export const MAX_MARGIN = { top: 56, right: 24, bottom: 140, left: 76 }

const icon = { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

export const TerminalNode = memo(function TerminalNode({ id, data, selected, dragging }: NodeProps<TerminalFlowNode>) {
  const { ptyId, name, status, startedAt, agent, pinned } = data
  const host = useRef<HTMLDivElement>(null)
  const nameBtn = useRef<HTMLButtonElement>(null)
  const exitedRef = useRef(status === 'exited')
  exitedRef.current = status === 'exited'
  const closeNode = useCanvas((s) => s.closeNode)
  const togglePin = useCanvas((s) => s.togglePin)
  const setMaximized = useCanvas((s) => s.setMaximized)
  const maximized = useCanvas((s) => s.maximized === ptyId)
  const grouped = useCanvas((s) => s.nodes.some((n) => n.id === ptyId && n.parentId !== undefined)) // laid out by its group: no drag, no resize
  // the Orchestrator's own card: it lives inside its node and only shows maximized, so it has no position to pin
  const docked = useCanvas((s) => {
    const parent = s.nodes.find((n) => n.id === ptyId)?.parentId
    return parent !== undefined && s.nodes.some((n) => n.id === parent && n.type === 'orchestrator')
  })
  const [details, setDetails] = useState(false)
  const [focused, setFocused] = useState(false) // keyboard focus is inside the terminal: it is never unmounted under the user
  const wasLow = useRef(false)
  const lowZoom = useStore((s) => (wasLow.current = s.transform[2] < LOW_ZOOM + (wasLow.current ? ZOOM_HYSTERESIS : 0)))
  const showTerm = !lowZoom || selected || maximized || focused
  const termRef = useRef<Terminal | null>(null)
  // Crisp text at any zoom: the terminal is drawn at the on-screen size (font and box scaled by the board zoom, then scaled back
  // by 1/zoom), so its pixels are never resampled. Follows the zoom once it settles; a maximized card is already at scale 1.
  const flow = useStoreApi()
  const drawScaleRef = useRef(1)
  const [settled, setSettled] = useState(() => flow.getState().transform[2])
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = flow.subscribe((st) => {
      clearTimeout(t)
      t = setTimeout(() => setSettled(st.transform[2]), 150)
    })
    return () => {
      clearTimeout(t)
      off()
    }
  }, [flow])
  const drawScale = maximized ? 1 : Math.min(2, Math.max(0.4, settled))
  drawScaleRef.current = drawScale
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.fontSize = FONT_PX * drawScale // columns and rows stay: the box scales with the font
  }, [drawScale])
  const restoreRef = useRef<(() => void) | null>(null)
  const activeBoard = useCanvas((st) => st.activeWorkspace === data.workspaceId)
  const paused = useCanvas((s) => s.paused) && isAlive(data) // Pause all holds the process: shown over its live state, which comes back on resume
  const pill = statusPill(paused ? 'paused' : agent ? agent.state : status)
  // maximized: the card leaves its slot and covers the viewport, staying put while the canvas pans or zooms; the terminal is never remounted.
  // Sized in screen px and scaled by 1/zoom, so the net scale is 1: the text stays readable and the column count stays sane at any zoom.
  // Not maximized, the selector is constant, so panning the canvas does not re-render every card.
  const bigStyle = useStore((s): CSSProperties | undefined => {
    if (!maximized) return undefined
    const [tx, ty, zoom] = s.transform
    const abs = s.nodeLookup.get(id)?.internals.positionAbsolute
    return {
      position: 'absolute',
      left: (MAX_MARGIN.left - tx) / zoom - (abs?.x ?? 0),
      top: (MAX_MARGIN.top - ty) / zoom - (abs?.y ?? 0),
      width: s.width - MAX_MARGIN.left - MAX_MARGIN.right,
      height: s.height - MAX_MARGIN.top - MAX_MARGIN.bottom,
      transform: `scale(${1 / zoom})`,
      transformOrigin: '0 0',
      // the Orchestrator's card is hidden on the board and only appears maximized
      visibility: 'visible',
      pointerEvents: 'all',
    }
  }, shallow)
  const pinTipId = useId()

  useEffect(() => {
    if (!maximized) return
    // Esc restores unless it is typed into the terminal, where it belongs to the CLI (it interrupts Claude)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('.xterm'))) setMaximized(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized, setMaximized])

  useEffect(() => {
    const el = host.current
    const box = el?.parentElement
    if (!el || !box) return
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: FONT_PX * drawScaleRef.current,
      cursorBlink: true,
      scrollback: 2000,
      theme: { background: '#0a0a0b', foreground: '#d4d4d8', cursor: '#ff6a2b', selectionBackground: 'rgb(255 106 43 / 0.35)', scrollbarSliderBackground: 'rgb(255 106 43 / 0.2)', scrollbarSliderHoverBackground: 'rgb(255 106 43 / 0.4)', scrollbarSliderActiveBackground: 'rgb(255 106 43 / 0.6)' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // GPU renderer: it draws block and box characters itself, edge to edge (the DOM renderer leaves seams between cells).
    // Falls back to the DOM renderer when WebGL is unavailable or the context is lost.
    try {
      if (DOM_RENDERER) throw new Error('DOM renderer requested')
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose())
      term.loadAddon(gl)
    } catch {
      // DOM renderer stays
    }
    termRef.current = term
    restoreRef.current = () => {
      if (box.clientWidth === 0 || box.clientHeight === 0) return
      fit.fit()
      term.refresh(0, term.rows - 1)
    }

    let last = { cols: 0, rows: 0 }
    let timer: ReturnType<typeof setTimeout> | undefined
    const refit = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (box.clientWidth === 0 || box.clientHeight === 0) return
        fit.fit()
        if (term.cols === last.cols && term.rows === last.rows) return
        last = { cols: term.cols, rows: term.rows }
        if (!exitedRef.current) void window.api.invoke('pty:resize', { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => undefined)
      }, 60)
    }
    const ro = new ResizeObserver(refit)
    ro.observe(box) // the card's own box: a zoom change alone never refits (the PTY keeps its size)
    void document.fonts.load('11px "JetBrains Mono Variable"').finally(refit)

    const input = term.onData((d) => {
      if (exitedRef.current) return
      for (let i = 0; i < d.length; i += CHUNK) {
        void window.api.invoke('pty:write', { id: ptyId, data: d.slice(i, i + CHUNK) }).catch(() => undefined)
      }
    })
    // Flow control: tell main how much xterm has actually processed so it can pause a noisy PTY.
    let processed = 0
    const ack = (n: number) => {
      processed += n
      if (processed < ACK_EVERY) return
      const bytes = processed
      processed = 0
      void window.api.invoke('pty:ack', { id: ptyId, bytes }).catch(() => undefined)
    }
    const detach = attach(ptyId, {
      write: (d) => term.write(d, () => ack(d.length)),
      exit: (code) => term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`),
    })
    term.focus()

    return () => {
      termRef.current = null
      restoreRef.current = null
      clearTimeout(timer)
      ro.disconnect()
      detach()
      input.dispose()
      term.dispose()
    }
  }, [ptyId])

  // zoomed back in: the container is shown again (it was display:none), so refit and repaint what the paused renderer skipped
  useEffect(() => {
    if (!showTerm) return
    const f = requestAnimationFrame(() => restoreRef.current?.())
    return () => cancelAnimationFrame(f)
  }, [showTerm])

  const pinTip = grouped ? 'Position is set by the group' : undefined
  return (
    <>
    {/* drag-to-connect handles sit outside the card, which clips its content */}
    {agent && !docked && (['l', 'r'] as const).map((side) => <Handle key={side} id={side} type="source" position={side === 'l' ? Position.Left : Position.Right} className="flow-handle" title={`Drag to connect ${name}`} />)}
    <div
      className={`term-card flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface ${selected ? 'is-selected border-accent-light' : 'border-accent/55'}`}
      style={bigStyle}
      data-testid={agent ? 'agent-node' : 'terminal-node'}
      data-name={name}
      data-status={status}
      data-state={agent?.state}
      data-pinned={pinned ? 'true' : undefined}
      data-paused={paused || undefined}
      data-maximized={maximized ? 'true' : undefined}
      data-lowzoom={showTerm ? undefined : 'true'}
      onFocus={(e) => e.target instanceof Element && e.target.closest('.xterm') && setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
    >
      <NodeResizer minWidth={300} minHeight={180} isVisible={selected && !grouped && !pinned && !maximized} lineClassName="resize-line" handleClassName="resize-handle" />
      <div className={`${maximized ? '' : 'drag-handle'} card-head ${grouped || pinned || maximized ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'}`}>
        <span className={`status-dot shrink-0 ${agent ? `st-${agent.state}` : status === 'running' ? 'status-working' : 'status-exited'}`} aria-hidden="true" />
        {agent ? (
          <button ref={nameBtn} type="button" className="name-btn nodrag" aria-haspopup="dialog" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
            {name}
          </button>
        ) : (
          <span className="name-text">{name}</span>
        )}
        {agent ? (
          <span className={`tag ${agent.bypass ? 'tag-bypass' : 'tag-role'}`} data-testid="role-tag">
            {agent.bypass ? 'BYPASS' : agent.role}
          </span>
        ) : (
          <span className="tag tag-muted" data-testid="role-tag">
            shell
          </span>
        )}
        <span className={`status-pill ml-auto ${pill.active ? 'status-pill-on' : ''}`} data-testid="status-word">
          {pill.label}
        </span>
        {!docked && (
          <button
            type="button"
            className="icon-btn nodrag"
            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${name}`}
            aria-pressed={!!pinned}
            aria-disabled={grouped || undefined}
            aria-describedby={pinTip ? pinTipId : undefined}
            data-tip={pinTip}
            title={pinTip ? undefined : pinned ? 'Unpin position' : 'Pin position'}
            onClick={() => !grouped && togglePin(ptyId)}
          >
            <svg {...icon} fill={pinned ? 'currentColor' : 'none'}>
              <path d="M4.2 1.5h3.6l-.5 3.1 1.7 1.7H3L4.7 4.6z" />
              <path d="M6 6.4v4.1" />
            </svg>
          </button>
        )}
        {pinTip && !docked && (
          <span id={pinTipId} className="sr-only">
            {pinTip}
          </span>
        )}
        <button
          type="button"
          className="icon-btn nodrag"
          aria-label={`${maximized ? 'Restore' : 'Maximize'} ${name}`}
          aria-pressed={maximized}
          title={maximized ? 'Restore (Esc)' : 'Maximize'}
          onClick={() => setMaximized(maximized ? null : ptyId)}
        >
          <svg {...icon}>
            {maximized ? <path d="M4.5 1.5v3h-3M10.5 4.5h-3v-3M7.5 10.5v-3h3M1.5 7.5h3v3" /> : <path d="M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" />}
          </svg>
        </button>
        <button type="button" className="icon-btn icon-btn-close nodrag" aria-label={`Close ${name}`} onClick={() => void closeNode(ptyId)}>
          <svg {...icon} strokeWidth={1.5}>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      {details && agent && (
        <DetailsPopover
          workspaceId={data.workspaceId}
          ptyId={ptyId}
          name={name}
          agent={agent}
          startedAt={startedAt}
          running={status === 'running'}
          onClose={() => {
            setDetails(false)
            nameBtn.current?.focus()
          }}
        />
      )}
      <div className={`nodrag nowheel nopan relative min-h-0 flex-1 overflow-hidden border-t border-white/10 bg-background ${showTerm ? '' : 'hidden'}`} data-testid="terminal-body">
        <div ref={host} className="absolute left-0 top-0 origin-top-left" style={{ width: `${drawScale * 100}%`, height: `${drawScale * 100}%`, transform: `scale(${1 / drawScale})` }} />
      </div>
      {!showTerm && activeBoard && <TailPreview term={termRef} exited={status === 'exited'} />}

    </div>
    </>
  )
})

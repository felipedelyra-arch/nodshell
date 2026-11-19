import { Handle, NodeResizer, Position, useStore, useStoreApi, type NodeProps } from '@xyflow/react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { memo, useEffect, useId, useRef, useState, type ComponentProps, type CSSProperties } from 'react'
import { shallow } from 'zustand/shallow'
import { statusPill } from '../../shared/agent'
import { DetailsPopover } from '../agent/DetailsPopover'
import { isFocusChord } from '../board/focusChord'
import { isAlive } from '../graph'
import { useCanvas, type TerminalFlowNode } from '../store'
import { attach } from './bus'
import { snapShift } from './snap'
import { TailPreview } from './TailPreview'

const CHUNK = 32768
const ACK_EVERY = 50_000
const FONT_PX = 11
const MAX_FONT_PX = 14 // a maximized card is for reading: larger text, and the terminal gets the columns that fit
const DOM_RENDERER = new URLSearchParams(location.search).get('renderer') === 'dom' // set by main in tests only
// semantic zoom: when the terminal text would be smaller than this on screen (FONT_PX x board zoom) the card shows a readable summary instead;
// the terminal comes back at MIN_LEGIBLE_FONT_PX + hysteresis so it does not flicker
export const MIN_LEGIBLE_FONT_PX = 9
const FONT_HYSTERESIS_PX = 0.5
// screen margins left free around a maximized card: top bar, bottom bar, the left toolbar and a little air
export const MAX_MARGIN = { top: 56, right: 24, bottom: 140, left: 76 }

/** xterm paints on a canvas: it needs the token's value, not a var() */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const icon = { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** The summary needs the live zoom, which only low-zoom cards subscribe to. */
function Summary(props: Omit<ComponentProps<typeof TailPreview>, 'zoom'>) {
  return <TailPreview {...props} zoom={useStore((s) => s.transform[2])} />
}

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
  const summaryClick = useRef(0)
  const [focused, setFocused] = useState(false) // keyboard focus is inside the terminal: it is never unmounted under the user
  const wasLow = useRef(false)
  const lowZoom = useStore((s) => (wasLow.current = FONT_PX * s.transform[2] < MIN_LEGIBLE_FONT_PX + (wasLow.current ? FONT_HYSTERESIS_PX : 0)))
  const showTerm = !lowZoom || selected || maximized || focused
  const termRef = useRef<Terminal | null>(null)
  // Crisp text at any zoom: the terminal is drawn at the on-screen size (font and box scaled by the board zoom, then scaled back
  // by 1/zoom), so its pixels are never resampled. Follows the zoom once it settles; a maximized card is already at scale 1.
  const flow = useStoreApi()
  const drawScaleRef = useRef(1)
  const [settled, setSettled] = useState(() => flow.getState().transform[2])
  // The viewport transform and node positions leave the canvas on a fractional device pixel, which the compositor resamples (blur).
  // Once things settle, a tiny translate on the host moves it onto a whole device pixel; it is added to the one already applied.
  const [nudge, setNudge] = useState({ x: 0, y: 0 })
  const nudgeRef = useRef(nudge)
  nudgeRef.current = nudge
  const snapRef = useRef(() => {})
  snapRef.current = () => {
    const el = host.current
    const box = el?.parentElement
    if (!el || !box || box.offsetWidth === 0 || box.offsetHeight === 0) return // hidden terminal: nothing to align
    const r = (el.querySelector('.xterm-screen') ?? el).getBoundingClientRect()
    const b = box.getBoundingClientRect()
    const dpr = window.devicePixelRatio
    const x = snapShift(r.left, dpr, b.width / box.offsetWidth)
    const y = snapShift(r.top, dpr, b.height / box.offsetHeight)
    if (Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4) return
    const cur = nudgeRef.current
    setNudge({ x: cur.x + x, y: cur.y + y })
  }
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = flow.subscribe((st) => {
      clearTimeout(t)
      t = setTimeout(() => {
        setSettled(st.transform[2])
        snapRef.current()
      }, 150)
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
    if (term) term.options.fontSize = maximized ? MAX_FONT_PX : FONT_PX * drawScale // columns and rows stay: the box scales with the font
  }, [drawScale, maximized])
  // maximize/restore, a terminal shown again or a new draw scale move the canvas without a flow-store change to wait for
  useEffect(() => {
    if (!showTerm) return
    const t = setTimeout(() => snapRef.current(), 150)
    return () => clearTimeout(t)
  }, [drawScale, maximized, showTerm])
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
      theme: { background: token('--color-background'), foreground: token('--color-text'), cursor: token('--color-accent'), selectionBackground: token('--accent-35'), scrollbarSliderBackground: token('--accent-20'), scrollbarSliderHoverBackground: token('--accent-40'), scrollbarSliderActiveBackground: token('--accent-60') },
    })
    // false: xterm ignores the key. The focus chord is handled above; F6 is the way out of the terminal for the keyboard (every other key,
    // Tab included, belongs to the CLI): it puts the focus on the terminal's frame, from where Tab moves on and Enter comes back in
    term.attachCustomKeyEventHandler((e) => {
      if (isFocusChord(e)) return false
      if (e.key !== 'F6' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return true
      if (e.type === 'keydown') box.focus()
      return false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    if (term.textarea) term.textarea.tabIndex = -1 // reached with Enter on the frame (or a click), so Tab never lands where it cannot leave
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
      // output discarded on unmount was never acked: ack it now (with the pending remainder) or main keeps the PTY paused
      dropped: (chars) => {
        const bytes = processed + chars
        processed = 0
        if (!exitedRef.current) void window.api.invoke('pty:ack', { id: ptyId, bytes }).catch(() => undefined)
      },
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
      className={`term-card flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface ${selected ? 'is-selected border-accent-light' : 'border-accent/55'} ${focused ? 'is-focused' : ''} ${details && agent ? 'has-details' : ''}`}
      style={bigStyle}
      data-testid={agent ? 'agent-node' : 'terminal-node'}
      data-name={name}
      data-status={status}
      data-state={agent?.state}
      data-pinned={pinned ? 'true' : undefined}
      data-paused={paused || undefined}
      data-maximized={maximized ? 'true' : undefined}
      data-lowzoom={showTerm ? undefined : 'true'}
      // double-click on the summary: two presses within 500 ms. The first one can select the card, which swaps the summary for the terminal, so the
      // second press lands on either and no dblclick event arrives.
      onMouseDownCapture={(e) => {
        if (!(e.target instanceof Element) || !e.target.closest('[data-testid=terminal-preview], [data-testid=terminal-body]')) return
        const again = Date.now() - summaryClick.current < 500
        summaryClick.current = !showTerm && e.target.closest('[data-testid=terminal-preview]') && !again ? Date.now() : 0
        if (again) setMaximized(ptyId)
      }}
      onFocus={(e) => e.target instanceof Element && e.target.closest('.xterm') && setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
    >
      <NodeResizer minWidth={300} minHeight={180} isVisible={selected && !grouped && !pinned && !maximized && !docked} lineClassName="resize-line" handleClassName="resize-handle" />
      <div
        className={`${maximized ? '' : 'drag-handle'} card-head select-none ${grouped || pinned || maximized ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
        onDoubleClick={(e) => !(e.target instanceof Element && e.target.closest('button')) && setMaximized(maximized ? null : ptyId)}
      >
        <span className={`status-dot shrink-0 ${agent ? `st-${agent.state}` : status === 'running' ? 'status-working' : 'status-exited'}`} aria-hidden="true" />
        {agent ? (
          <button ref={nameBtn} type="button" className="name-btn nodrag" aria-haspopup="dialog" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
            <span>{name}</span>
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
          title={maximized ? 'Restore (Ctrl+Shift+F, Esc outside the terminal, or double-click the header)' : 'Maximize (Ctrl+Shift+F, or double-click the header)'}
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
      <div className={`term-body nodrag nowheel nopan relative min-h-0 flex-1 overflow-hidden border-t border-white/10 bg-background ${showTerm ? '' : 'hidden'}`}
        data-testid="terminal-body"
        tabIndex={0}
        role="group"
        aria-label={`Terminal of ${name}. Press Enter to type in it; F6 comes back here.`}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.target !== e.currentTarget) return
          e.preventDefault()
          termRef.current?.focus()
        }}
      >
        <div ref={host} className="absolute left-0 top-0 origin-top-left" style={{ width: `${drawScale * 100}%`, height: `${drawScale * 100}%`, transform: `translate(${nudge.x}px, ${nudge.y}px) scale(${1 / drawScale})` }} />
      </div>
      {!showTerm && activeBoard && <Summary term={termRef} exited={status === 'exited'} name={name} status={pill.label} />}

    </div>
    </>
  )
})

import { getViewportForBounds } from '@xyflow/react'
import { createContext, forwardRef, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ANNOTATION_COLORS } from '../../shared/annotation'
import { addImage, createAtCenter, currentFlow } from '../annotations/actions'
import { boundsOf } from '../annotations/geometry'
import { EMPTY, useAnnotations, type Tool } from '../annotations/store'
import { onBoard } from '../board/focus'
import { inWorkspace } from '../graph'
import { useCanvas } from '../store'
import { WebTilePopover } from '../webtile/WebTilePopover'
import { WEBTILES_MAX } from '../../shared/webtile'

const COLOR_NAMES: Record<string, string> = { '#ff6a2b': 'Orange', '#ffd23d': 'Yellow', '#3ddc84': 'Green', '#4cc9f0': 'Cyan', '#a78bfa': 'Violet', '#ff6b9d': 'Pink', '#e4e4e7': 'Light gray', '#ff4d4f': 'Red' }
/** margins the board keeps free around what Expand fits: top bar, bottom bars, this toolbar */
export const FIT_PADDING = { top: '56px', bottom: '140px', left: '76px', right: '24px' } as const

const ico = { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const ICONS = {
  select: <path d="M5 3.5l10 5.5-4.4 1.6L9 15.2z" />,
  agent: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="3" />
      <path d="M6.8 8.6l2.4 1.9-2.4 1.9M11 12.6h2.6" />
    </>
  ),
  shape: (
    <>
      <rect x="3" y="8" width="8.5" height="8.5" rx="1.5" />
      <circle cx="13" cy="7.5" r="4" />
    </>
  ),
  web: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8h14M5.5 6h.01M7.5 6h.01" />
    </>
  ),
  text: <path d="M2.5 15.5l4-10 4 10M4 11.8h5M12.5 15.5l2.5-6 2.5 6M13.4 13.5h3.2" />,
  pen: <path d="M4 16l.9-3.6L13.6 3.7a1.5 1.5 0 012.1 0l.6.6a1.5 1.5 0 010 2.1L7.6 15.1zM12.2 5.1l2.7 2.7" />,
  eraser: <path d="M3.6 11.6l6.5-7.2a1.5 1.5 0 012.1-.1l3.5 3.1a1.5 1.5 0 01.1 2.1L10.4 15.6H6.6zM9.5 16.4H17" />,
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.2" />
      <path d="M3.5 14.5l4-3.5 3 2.5 2-1.5 3.5 3" />
    </>
  ),
  expand: <path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />,
} satisfies Record<string, ReactNode>

/** the index of the one button in the tab order (roving focus) */
const TabStop = createContext(0)

type ToolButtonProps = {
  idx: number
  label: string
  tip: string
  /** disabled: visibly and semantically, the tip says why */
  off?: string
  pressed?: boolean
  round?: boolean
  popup?: boolean
  expanded?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}

/** One toolbar button: the tip shows on hover and focus and is also its accessible description. */
const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton({ idx, label, tip, off, pressed, round, popup, expanded, onClick, children }, ref) {
  const tipId = useId()
  const stop = useContext(TabStop)
  const text = off ?? tip
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`tool-btn${round ? ' tool-btn-round' : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={off ? true : undefined}
        aria-haspopup={popup ? 'dialog' : undefined}
        aria-expanded={popup ? expanded : undefined}
        aria-describedby={tipId}
        data-tip={text}
        tabIndex={stop === idx ? 0 : -1}
        onClick={(e) => !off && onClick(e)}
      >
        <svg {...ico}>{children}</svg>
      </button>
      <span id={tipId} className="sr-only">
        {text}
      </span>
    </>
  )
})

/** A small palette; the colour is for what is drawn next (pen, shapes, notes). */
function ColorMenu({ onClose, anchor }: { onClose: () => void; anchor: React.RefObject<HTMLButtonElement | null> }) {
  const color = useAnnotations((s) => s.color)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-pressed=true]')?.focus()
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [onClose, anchor])
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Annotation color"
      className="color-menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="color-swatch"
          style={{ background: c }}
          aria-label={COLOR_NAMES[c] ?? c}
          aria-pressed={color === c}
          onClick={() => {
            useAnnotations.getState().setColor(c)
            onClose()
          }}
        />
      ))}
    </div>
  )
}

/** Frames everything in the active workspace: cards, groups, nodes and annotations. */
function fitAll(): void {
  const rf = currentFlow()
  const el = document.querySelector('.react-flow')
  if (!rf || !el) return
  const { nodes, activeWorkspace } = useCanvas.getState()
  const ids = inWorkspace(nodes, activeWorkspace).filter((n) => !n.parentId).map((n) => n.id)
  const rects = [...(ids.length ? [rf.getNodesBounds(ids)] : []), ...(useAnnotations.getState().items[activeWorkspace] ?? EMPTY).map((a) => boundsOf(a)).map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h }))]
  if (rects.length === 0) return
  const x1 = Math.min(...rects.map((r) => r.x))
  const y1 = Math.min(...rects.map((r) => r.y))
  const x2 = Math.max(...rects.map((r) => r.x + r.width))
  const y2 = Math.max(...rects.map((r) => r.y + r.height))
  const { width, height } = el.getBoundingClientRect()
  void rf.setViewport(getViewportForBounds({ x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) }, width, height, 0.2, 1, FIT_PADDING))
}

/** Single-key tools and image paste, only with the focus on the board; a drawing tool also keeps every key away from terminals. */
function useBoardKeys(): void {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const st = useAnnotations.getState()
      const t = e.target
      if (st.tool !== 'select' && t instanceof Element && t.closest('.xterm')) {
        // not to the terminal while drawing; Esc is the way out
        e.stopPropagation()
        e.preventDefault()
        if (e.key === 'Escape') st.setTool('select')
        return
      }
      if (e.key === 'Escape') {
        const busy = t instanceof Element && t.closest('input, textarea, select, [role=dialog], [role=menu], dialog, [contenteditable]')
        if (st.tool !== 'select' && !busy && !document.querySelector('[aria-modal=true], dialog[open]')) st.setTool('select')
        return
      }
      if (e.altKey || e.metaKey || !onBoard(t)) return
      if (e.ctrlKey) {
        if (e.key.toLowerCase() === 'v' && !e.shiftKey) {
          e.preventDefault()
          void addImage('paste')
        }
        return
      }
      if (e.shiftKey) return
      const tools: Record<string, Tool> = { v: 'select', t: 'text', p: 'pen', e: 'eraser' }
      const key = e.key.toLowerCase()
      if (key === 'r') st.pickShape()
      else if (tools[key]) st.setTool(tools[key]!)
      else if (e.key === 'Enter' && !e.repeat && (st.tool === 'shape' || st.tool === 'text')) createAtCenter()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', down, true)
    // leaving the selection tool takes the focus out of a terminal, so its keys stop there
    const off = useAnnotations.subscribe((s, p) => {
      const a = document.activeElement
      if (s.tool !== 'select' && p.tool === 'select' && a instanceof HTMLElement && a.closest('.xterm')) a.blur()
    })
    return () => {
      window.removeEventListener('keydown', down, true)
      off()
    }
  }, [])
}

/**
 * The left toolbar: selection, agents, shapes, web tile, text, pen, eraser, colour, image, fit. The mode tools are one
 * exclusive group (aria-pressed); the arrow keys move between the buttons (one tab stop).
 */
export function Toolbar({ agentTip, agentOpen, onAgent }: { agentTip?: string; agentOpen: boolean; onAgent: (opener: HTMLButtonElement) => void }) {
  useBoardKeys()
  const tool = useAnnotations((s) => s.tool)
  const shape = useAnnotations((s) => s.shape)
  const color = useAnnotations((s) => s.color)
  const active = useCanvas((s) => s.activeWorkspace)
  const nodesHere = useCanvas((s) => s.nodes.some((n) => n.data.workspaceId === active && !n.parentId))
  const drawnHere = useAnnotations((s) => (s.items[active]?.length ?? 0) > 0)
  const hasContent = nodesHere || drawnHere
  const [colorOpen, setColorOpen] = useState(false)
  const [webOpen, setWebOpen] = useState(false)
  const webBtn = useRef<HTMLButtonElement>(null)
  const tiles = useCanvas((s) => s.nodes.filter((n) => n.type === 'webtile').length) // the limit is per window
  const [stop, setStop] = useState(0) // the one button in the tab order
  const bar = useRef<HTMLDivElement>(null)
  const colorBtn = useRef<HTMLButtonElement>(null)
  const buttons = () => [...(bar.current?.querySelectorAll<HTMLButtonElement>('button.tool-btn') ?? [])]

  const choose = (t: Tool) => (e: React.MouseEvent) => {
    useAnnotations.getState().setTool(t)
    if (e.detail > 0 && t !== 'select') useAnnotations.getState().requestFocus() // by mouse: onto the drawing surface, so Space still means voice
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = buttons()
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    const to = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i - 1 + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setStop(to)
    all[to]?.focus()
  }

  return (
    <div ref={bar} role="toolbar" aria-label="Board tools" aria-orientation="vertical" className="board-toolbar" onKeyDown={onKeyDown} onFocus={(e) => setStop(Math.max(0, buttons().findIndex((b) => b.contains(e.target as Node))))}>
      <TabStop.Provider value={stop}>
      <ToolButton idx={0} round label="Select" tip="Select (V)" pressed={tool === 'select'} onClick={choose('select')}>
        {ICONS.select}
      </ToolButton>
      <ToolButton idx={1} label="Add agents" tip="Add agents" popup expanded={agentOpen} off={agentTip} onClick={(e) => onAgent(e.currentTarget)}>
        {ICONS.agent}
      </ToolButton>
      <ToolButton idx={2} label="Shapes" tip={`Shapes (R): ${shape === 'rect' ? 'rectangle' : 'ellipse'}, press again for ${shape === 'rect' ? 'ellipse' : 'rectangle'}`} pressed={tool === 'shape'} onClick={(e) => {
        useAnnotations.getState().pickShape()
        if (e.detail > 0) useAnnotations.getState().requestFocus()
      }}>
        {ICONS.shape}
      </ToolButton>
      <span className="relative">
        <ToolButton idx={3} ref={webBtn} label="Web tile" tip="Web tile: a live page (localhost preview or a URL)" popup expanded={webOpen} off={tiles >= WEBTILES_MAX ? `Web tile limit reached (${WEBTILES_MAX})` : undefined} onClick={() => setWebOpen((o) => !o)}>
          {ICONS.web}
        </ToolButton>
        {webOpen && (
          <WebTilePopover
            anchor={webBtn}
            onClose={() => {
              setWebOpen(false)
              webBtn.current?.focus()
            }}
          />
        )}
      </span>
      <ToolButton idx={4} label="Text" tip="Text note (T)" pressed={tool === 'text'} onClick={choose('text')}>
        {ICONS.text}
      </ToolButton>
      <ToolButton idx={5} label="Pen" tip="Pen (P)" pressed={tool === 'pen'} onClick={choose('pen')}>
        {ICONS.pen}
      </ToolButton>
      <ToolButton idx={6} label="Eraser" tip="Eraser (E)" pressed={tool === 'eraser'} onClick={choose('eraser')}>
        {ICONS.eraser}
      </ToolButton>
      <span className="relative">
        <ToolButton idx={7} ref={colorBtn} label="Color" tip="Color for the pen, shapes and notes" popup expanded={colorOpen} onClick={() => setColorOpen((o) => !o)}>
          <circle cx="10" cy="10" r="6.5" />
          <circle cx="10" cy="10" r="3.4" fill={color} stroke="none" />
        </ToolButton>
        {colorOpen && (
          <ColorMenu
            anchor={colorBtn}
            onClose={() => {
              setColorOpen(false)
              colorBtn.current?.focus()
            }}
          />
        )}
      </span>
      <ToolButton idx={8} label="Image" tip="Add an image (PNG, JPEG, WebP or GIF), or paste with Ctrl+V" onClick={() => void addImage('pick')}>
        {ICONS.image}
      </ToolButton>
      <ToolButton idx={9} label="Fit to content" tip="Fit everything in view" off={hasContent ? undefined : 'Nothing on this board yet'} onClick={fitAll}>
        {ICONS.expand}
      </ToolButton>
      </TabStop.Provider>
    </div>
  )
}

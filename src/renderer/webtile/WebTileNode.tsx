import { NodeResizer, useStore, useStoreApi, type NodeProps } from '@xyflow/react'
import { memo, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { shallow } from 'zustand/shallow'
import { ADDRESS_MAX, type PageWidth } from '../../shared/webtile'
import { useAnnotations } from '../annotations/store'
import { TILE_MIN, type AppNode, type WebTileFlowNode } from '../graph'
import { useCanvas } from '../store'
import { MAX_MARGIN } from '../terminal/TerminalNode'
import { freeArea, overlaps, tileVisible, type Rect } from './visibility'

/** anything of the app that opens over the board */
const OVERLAY = '[role=dialog], [role=menu], [role=listbox], dialog[open], [aria-modal=true]'
/** a left-toolbar tip shows to the right of the toolbar, this far into the board */
const TOOLBAR_TIP_REACH = 340
const NOWHERE: Rect = { x: 0, y: 0, width: 0, height: 0 }

const icon = { width: 14, height: 14, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const sizeOf = (n: AppNode) => ({ w: Number(n.style?.width ?? n.width ?? n.measured?.width ?? 0), h: Number(n.style?.height ?? n.height ?? n.measured?.height ?? 0) })

/** Another top-level node of the tile's board overlaps it (the native page would hide it). */
function overlapped(nodes: AppNode[], id: string): boolean {
  const me = nodes.find((n) => n.id === id)
  if (!me) return false
  const r: Rect = { x: me.position.x, y: me.position.y, width: sizeOf(me).w, height: sizeOf(me).h }
  return nodes.some((n) => n.id !== id && !n.parentId && n.data.workspaceId === me.data.workspaceId && overlaps(r, { x: n.position.x, y: n.position.y, width: sizeOf(n).w, height: sizeOf(n).h }))
}

/**
 * Keeps main told, at most once per frame and with one request in flight per tile, where the body and the board's free area are in
 * the window, the board zoom and whether the native page may show (see tileVisible; main draws only the part inside the free area).
 * Returns whether it is shown now (else the static mirror shows).
 */
function usePlacement(id: string, body: React.RefObject<HTMLDivElement | null>, resizing: React.RefObject<boolean>): boolean {
  const flow = useStoreApi()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    let raf = 0
    let last = ''
    let busy = false
    let pending: { id: string; x: number; y: number; width: number; height: number; free: Rect; zoom: number; visible: boolean; pageWidth: PageWidth | null } | null = null
    const flush = () => {
      if (busy || !pending) return
      const p = pending
      pending = null
      busy = true
      void window.api
        .invoke('webtile:place', p)
        .catch(() => undefined)
        .finally(() => {
          busy = false
          flush()
        })
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = body.current
      if (!el) return
      const s = useCanvas.getState()
      const me = s.nodes.find((n) => n.id === id)
      if (!me || me.data.workspaceId !== s.activeWorkspace) {
        // another board is in view: hidden once, then nothing is measured until it comes back
        if (last === 'away') return
        last = 'away'
        pending = { id, ...NOWHERE, free: NOWHERE, zoom: 1, visible: false, pageWidth: me?.type === 'webtile' ? (me.data.pageWidth ?? null) : null }
        setShown(false)
        return flush()
      }
      const r = el.getBoundingClientRect()
      const bottomChrome = document.querySelector('[data-chrome=bottom]')?.getBoundingClientRect().top ?? window.innerHeight
      const free = freeArea({ width: window.innerWidth, height: window.innerHeight }, { ...MAX_MARGIN, bottom: Math.max(MAX_MARGIN.bottom, window.innerHeight - bottomChrome + 8) })
      const tip = r.left < TOOLBAR_TIP_REACH && document.querySelector('.board-toolbar .tool-btn:hover, .board-toolbar .tool-btn:focus-visible') !== null
      const fs = flow.getState()
      const mine = me.type === 'webtile' ? (me.data.pageWidth ?? null) : null
      const big = s.maximized === id
      const visible = tileVisible({ x: r.left, y: r.top, width: r.width, height: r.height }, free, {
        activeWorkspace: true,
        overlay: tip || document.querySelector(OVERLAY) !== null,
        maximized: s.maximized !== null && !big, // a maximized tile is the one page that shows
        moving: resizing.current || fs.userSelectionActive || s.nodes.some((n) => n.dragging || n.resizing),
        selectTool: useAnnotations.getState().tool === 'select',
        overlapped: !big && overlapped(s.nodes, id),
      })
      const p = { id, x: r.left, y: r.top, width: r.width, height: r.height, free, zoom: big ? 1 : Math.min(4, Math.max(0.05, fs.transform[2])), visible, pageWidth: mine } // maximized: the page is at zoom 1 on the screen
      const key = `${p.x}|${p.y}|${p.width}|${p.height}|${free.x}|${free.y}|${free.width}|${free.height}|${p.zoom}|${p.visible}|${mine}`
      if (key === last) return
      last = key
      pending = p
      setShown(visible)
      flush()
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      void window.api.invoke('webtile:place', { id, ...NOWHERE, free: NOWHERE, zoom: 1, visible: false, pageWidth: null }).catch(() => undefined) // gone from the board: hidden at once
    }
  }, [id, body, resizing, flow])
  return shown
}

const VIEWPORTS: { width: PageWidth | null; label: string; text: string }[] = [
  { width: 390, label: 'Mobile', text: '390' },
  { width: 768, label: 'Tablet', text: '768' },
  { width: 1440, label: 'Desktop', text: '1440' },
  { width: null, label: 'Fit', text: 'Fit' },
]

/** The viewport preset menu of a tile: the page lays out at this width whatever the tile's size (main applies it). */
function ViewportMenu({ id, value }: { id: string; value: PageWidth | null }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    items()[Math.max(0, VIEWPORTS.findIndex((v) => v.width === value))]?.focus()
    const outside = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const close = () => {
    setOpen(false)
    btn.current?.focus()
  }
  const onKey = (e: React.KeyboardEvent) => {
    const all = items()
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.nativeEvent.stopImmediatePropagation() // closes the menu, not the focus mode
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    } else if (e.key === 'Tab') setOpen(false)
  }
  const current = VIEWPORTS.find((v) => v.width === value) ?? VIEWPORTS[3]!
  return (
    <div className="relative shrink-0">
      <button ref={btn} type="button" className="tile-viewport" aria-haspopup="menu" aria-expanded={open} aria-label={`Viewport: ${current.width === null ? 'Fit' : `${current.label} ${current.text}`}`} title="Viewport width of the page" onClick={() => setOpen((v) => !v)}>
        <span>{current.text}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label="Viewport" className="menu menu-end" onKeyDown={onKey}>
          {VIEWPORTS.map((v) => (
            <button
              key={v.label}
              type="button"
              role="menuitemradio"
              aria-checked={v.width === value}
              className="menu-item"
              onClick={() => {
                useCanvas.getState().setTilePageWidth(id, v.width)
                close()
              }}
            >
              <span>{v.label}</span>
              <span className="ml-auto font-mono">{v.width ?? 'page = tile'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A web tile: a title bar (status dot, page title, close), a navigation row (back, forward, reload, address) and the page. The page itself is a native view main
 * places over the body; while it may not show, the body shows its title and address instead.
 */
export const WebTileNode = memo(function WebTileNode({ id, data, selected, dragging }: NodeProps<WebTileFlowNode>) {
  const { title, address, loading, error, canGoBack = false, canGoForward = false, pageWidth = null } = data
  const maximized = useCanvas((s) => s.maximized === id)
  // focus mode: the tile leaves its slot and covers the board's free area, staying put while the canvas pans or zooms (as a maximized card does)
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
      pointerEvents: 'all',
    }
  }, shallow)
  const toggleMax = () => useCanvas.getState().setMaximized(useCanvas.getState().maximized === id ? null : id)
  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useCanvas.getState().setMaximized(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])
  const body = useRef<HTMLDivElement>(null)
  const resizing = useRef(false)
  const shown = usePlacement(id, body, resizing)
  /** what the user is typing; null while the field just follows the page's address */
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const hintId = useId()
  const label = title || address || 'Web page'

  const stopEditing = () => {
    setDraft(null)
    setProblem(null)
  }
  const go = async () => {
    if (draft === null) return
    const err = await useCanvas.getState().navigateTile(id, draft)
    if (!err) return stopEditing()
    setProblem(err) // the field stays as typed, marked invalid; the message is the usual toast
    useCanvas.getState().notify(err, 'error')
  }
  const step = (way: 'back' | 'forward', can: boolean) => (can ? void useCanvas.getState().stepTile(id, way) : undefined)
  const enter = async () => {
    try {
      await window.api.invoke('webtile:focus', { id })
    } catch {
      useCanvas.getState().notify('The page is covered or off screen; bring it into view first.', 'info')
    }
  }

  return (
    <div
      className={`web-tile flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface ${selected ? 'is-selected border-white/45' : 'border-white/15'}`}
      style={bigStyle}
      data-testid="web-tile"
      data-maximized={maximized ? 'true' : undefined}
      data-shown={shown ? 'true' : 'false'}
      data-loading={loading ? 'true' : undefined}
    >
      <NodeResizer
        minWidth={TILE_MIN.w}
        minHeight={TILE_MIN.h}
        isVisible={selected && !maximized}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeStart={() => (resizing.current = true)}
        onResizeEnd={() => (resizing.current = false)}
      />
      <div
        className={`drag-handle card-head ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onDoubleClick={(e) => {
          if (!(e.target as Element).closest('button')) toggleMax()
        }}
      >
        <span className={`status-dot shrink-0 ${error ? 'st-error' : loading ? 'st-working' : 'st-idle'}`} aria-hidden="true" />
        <span className="name-text tile-title flex-1" title={address} data-testid="tile-title">
          {error ? `${label} · ${error}` : label}
        </span>
        <button type="button" className="icon-btn nodrag" aria-label={maximized ? 'Leave focus mode' : 'Focus mode'} aria-pressed={maximized} title={maximized ? 'Restore (Esc)' : 'Focus mode (Ctrl+Shift+F)'} onClick={toggleMax}>
          <svg {...icon}>{maximized ? <path d="M4.5 1.8v2.7H1.8M7.5 10.2V7.5h2.7M4.5 4.5L1.8 1.8M7.5 7.5l2.7 2.7" /> : <path d="M1.8 4.5V1.8h2.7M10.2 7.5v2.7H7.5M1.8 1.8l3 3M10.2 10.2l-3-3" />}</svg>
        </button>
        <button type="button" className="icon-btn icon-btn-close nodrag" aria-label="Close web tile" title="Close" onClick={() => void useCanvas.getState().closeTile(id)}>
          <svg {...icon} strokeWidth={1.5}>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      <div className="tile-nav nodrag">
        <button type="button" className="icon-btn" aria-label="Back" aria-disabled={!canGoBack} title={canGoBack ? 'Back' : 'Nothing to go back to'} onClick={() => step('back', canGoBack)}>
          <svg {...icon}>
            <path d="M7.5 2L3.5 6l4 4" />
          </svg>
        </button>
        <button type="button" className="icon-btn" aria-label="Forward" aria-disabled={!canGoForward} title={canGoForward ? 'Forward' : 'Nothing to go forward to'} onClick={() => step('forward', canGoForward)}>
          <svg {...icon}>
            <path d="M4.5 2l4 4-4 4" />
          </svg>
        </button>
        <button type="button" className="icon-btn" aria-label="Reload page" title="Reload" onClick={() => void useCanvas.getState().reloadTile(id)}>
          <svg {...icon}>
            <path d="M10 6a4 4 0 11-1.2-2.85M10 1.8v2.6H7.4" />
          </svg>
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
        >
          <input
            className="tile-address"
            aria-label="Address"
            aria-invalid={problem ? true : undefined}
            aria-describedby={hintId}
            maxLength={ADDRESS_MAX}
            spellCheck={false}
            value={draft ?? address}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setDraft(e.target.value)
              setProblem(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                stopEditing()
                e.currentTarget.blur()
              }
            }}
            onBlur={stopEditing}
          />
          <span id={hintId} className="sr-only">
            {problem ?? 'Enter opens the address (http or https only), Esc restores it.'}
          </span>
        </form>
        <ViewportMenu id={id} value={pageWidth} />
      </div>
      {/* the native page sits over this box; the box itself is the keyboard way in (Enter) and, while the page is hidden, its static mirror (title and address) */}
      <div
        ref={body}
        role="button"
        tabIndex={0}
        className="tile-body nodrag nopan nowheel min-h-0 flex-1 border-t border-white/10"
        data-tile-body={id}
        aria-label={`Page: ${label}. Press Enter to use the page; F6 in the page comes back here.`}
        title="Press Enter to use the page; F6 in the page comes back"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            void enter()
          }
        }}
      >
        {!shown && (
          <span className="tile-mirror-text" data-testid="tile-mirror">
            <strong>{label}</strong>
            <span>{address}</span>
          </span>
        )}
      </div>
    </div>
  )
})

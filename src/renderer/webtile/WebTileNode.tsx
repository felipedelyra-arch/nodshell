import { NodeResizer, useStoreApi, type NodeProps } from '@xyflow/react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { ADDRESS_MAX } from '../../shared/webtile'
import { useAnnotations } from '../annotations/store'
import { TILE_MIN, type AppNode, type WebTileFlowNode } from '../graph'
import { useCanvas } from '../store'
import { MAX_MARGIN } from '../terminal/TerminalNode'
import { freeArea, overlaps, tileVisible, type Rect } from './visibility'

/** anything of the app that opens over the board */
const OVERLAY = '[role=dialog], [role=menu], [role=listbox], dialog[open], [aria-modal=true]'
/** a left-toolbar tip shows to the right of the toolbar, this far into the board */
const TOOLBAR_TIP_REACH = 340

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
 * Keeps main told, at most once per frame and with one request in flight per tile, where the body is in the window, the board zoom
 * and whether the native page may show (see tileVisible). Returns whether it is shown now (else the static mirror shows).
 */
function usePlacement(id: string, body: React.RefObject<HTMLDivElement | null>, resizing: React.RefObject<boolean>): boolean {
  const flow = useStoreApi()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    let raf = 0
    let last = ''
    let busy = false
    let pending: { id: string; x: number; y: number; width: number; height: number; zoom: number; visible: boolean } | null = null
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
        pending = { id, x: 0, y: 0, width: 0, height: 0, zoom: 1, visible: false }
        setShown(false)
        return flush()
      }
      const r = el.getBoundingClientRect()
      const bottomChrome = document.querySelector('[data-chrome=bottom]')?.getBoundingClientRect().top ?? window.innerHeight
      const free = freeArea({ width: window.innerWidth, height: window.innerHeight }, { ...MAX_MARGIN, bottom: Math.max(MAX_MARGIN.bottom, window.innerHeight - bottomChrome + 8) })
      const tip = r.left < TOOLBAR_TIP_REACH && document.querySelector('.board-toolbar .tool-btn:hover, .board-toolbar .tool-btn:focus-visible') !== null
      const fs = flow.getState()
      const visible = tileVisible({ x: r.left, y: r.top, width: r.width, height: r.height }, free, {
        activeWorkspace: true,
        overlay: tip || document.querySelector(OVERLAY) !== null,
        maximized: s.maximized !== null,
        moving: resizing.current || fs.userSelectionActive || s.nodes.some((n) => n.dragging || n.resizing),
        selectTool: useAnnotations.getState().tool === 'select',
        overlapped: overlapped(s.nodes, id),
      })
      const p = { id, x: r.left, y: r.top, width: r.width, height: r.height, zoom: Math.min(4, Math.max(0.05, fs.transform[2])), visible }
      const key = `${p.x}|${p.y}|${p.width}|${p.height}|${p.zoom}|${p.visible}`
      if (key === last) return
      last = key
      pending = p
      setShown(visible)
      flush()
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      void window.api.invoke('webtile:place', { id, x: 0, y: 0, width: 0, height: 0, zoom: 1, visible: false }).catch(() => undefined) // gone from the board: hidden at once
    }
  }, [id, body, resizing, flow])
  return shown
}

/**
 * A web tile: a title bar (status dot, page title, reload, edit address, close) over the page. The page itself is a native view main
 * places over the body; while it may not show, the body shows its title and address instead.
 */
export const WebTileNode = memo(function WebTileNode({ id, data, selected, dragging }: NodeProps<WebTileFlowNode>) {
  const { title, address, loading, error } = data
  const body = useRef<HTMLDivElement>(null)
  const editBtn = useRef<HTMLButtonElement>(null)
  const resizing = useRef(false)
  const shown = usePlacement(id, body, resizing)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const hintId = useId()
  const label = title || address || 'Web page'

  const stopEditing = () => {
    setEditing(false)
    setProblem(null)
    editBtn.current?.focus()
  }
  const go = async () => {
    const err = await useCanvas.getState().navigateTile(id, draft)
    if (!err) return stopEditing()
    setProblem(err) // the field stays open, marked invalid; the message is the usual toast
    useCanvas.getState().notify(err, 'error')
  }
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
      data-testid="web-tile"
      data-shown={shown ? 'true' : 'false'}
      data-loading={loading ? 'true' : undefined}
    >
      <NodeResizer
        minWidth={TILE_MIN.w}
        minHeight={TILE_MIN.h}
        isVisible={selected}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeStart={() => (resizing.current = true)}
        onResizeEnd={() => (resizing.current = false)}
      />
      <div className={`drag-handle card-head ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}>
        <span className={`status-dot shrink-0 ${error ? 'st-error' : loading ? 'st-working' : 'st-idle'}`} aria-hidden="true" />
        {editing ? (
          <form
            className="nodrag min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              void go()
            }}
          >
            <input
              autoFocus
              className="tile-address"
              aria-label="Address"
              aria-invalid={problem ? true : undefined}
              aria-describedby={hintId}
              maxLength={ADDRESS_MAX}
              spellCheck={false}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setProblem(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  stopEditing()
                }
              }}
              onBlur={(e) => {
                if (!e.currentTarget.form?.contains(e.relatedTarget as Node | null)) setEditing(false)
              }}
            />
            <span id={hintId} className="sr-only">
              {problem ?? 'Enter opens the address (http or https only), Esc cancels.'}
            </span>
          </form>
        ) : (
          <span className="name-text tile-title flex-1" title={address} data-testid="tile-title">
            {error ? `${label} · ${error}` : label}
          </span>
        )}
        <button type="button" className="icon-btn nodrag" aria-label="Reload page" title="Reload" onClick={() => void useCanvas.getState().reloadTile(id)}>
          <svg {...icon}>
            <path d="M10 6a4 4 0 11-1.2-2.85M10 1.8v2.6H7.4" />
          </svg>
        </button>
        <button
          ref={editBtn}
          type="button"
          className="icon-btn nodrag"
          aria-label="Edit address"
          aria-pressed={editing}
          title="Edit address"
          onClick={() => {
            if (editing) return stopEditing()
            setDraft(address)
            setEditing(true)
          }}
        >
          <svg {...icon}>
            <path d="M2 10l.6-2.4 5.9-5.9a1 1 0 011.4 0l.4.4a1 1 0 010 1.4L4.4 9.4zM7.6 2.6l1.8 1.8" />
          </svg>
        </button>
        <button type="button" className="icon-btn icon-btn-close nodrag" aria-label="Close web tile" title="Close" onClick={() => void useCanvas.getState().closeTile(id)}>
          <svg {...icon} strokeWidth={1.5}>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
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

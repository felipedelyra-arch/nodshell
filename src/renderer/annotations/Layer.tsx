import { useReactFlow, useStore } from '@xyflow/react'
import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ANNOTATION_TEXT_MAX, type Annotation } from '../../shared/annotation'
import { useCanvas } from '../store'
import { bindFlow } from './actions'
import { boundsOf, moved, resizedBox, type Corner } from './geometry'
import { EMPTY, useAnnotations } from './store'

/** Served by main from its own directory, by id; the renderer never sees a path. */
const imageSrc = (id: string) => `app://app/board-image/${id}`
const NAMES = { stroke: 'Pen stroke', shape: 'Shape', text: 'Text note', image: 'Image' } as const
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const CURSORS: Record<Corner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }

const boxStyle = (a: { x: number; y: number; w: number; h: number }) => ({ left: a.x, top: a.y, width: a.w, height: a.h })

/** A text note being typed in: Enter is a new line, Esc or leaving the field ends it, an empty note is dropped. */
function Editor({ a, ws }: { a: Annotation & { kind: 'text' }; ws: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const finish = () => {
    const st = useAnnotations.getState()
    if (st.editing !== a.id) return
    st.setEditing(null)
    const cur = st.items[ws]?.find((x) => x.id === a.id)
    if (!cur || cur.kind !== 'text' || cur.text.trim() === '') st.remove(ws, [a.id])
  }
  return (
    <textarea
      ref={ref}
      className="annotation-editor nopan nowheel"
      aria-label="Text note"
      maxLength={ANNOTATION_TEXT_MAX}
      value={a.text}
      onChange={(e) => useAnnotations.getState().replace(ws, { ...a, text: e.target.value.replaceAll('\0', '').slice(0, ANNOTATION_TEXT_MAX) })}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          finish()
        }
      }}
      style={{ color: a.color }}
    />
  )
}

type DragFrom = { x: number; y: number; from: Annotation }

/** One annotation. With the selection tool it can be selected, moved, edited and deleted from the keyboard too. */
const Item = memo(function Item({ a, ws, interactive, stop }: { a: Annotation; ws: string; interactive: boolean; stop: boolean }) {
  const drag = useRef<DragFrom | null>(null)
  const editing = useAnnotations((s) => s.editing === a.id)
  const { getViewport } = useReactFlow()
  const st = useAnnotations.getState

  const props = interactive
    ? {
        // one tab stop for the whole layer (the selected item, else the last); PageUp and PageDown walk the rest
        tabIndex: stop ? 0 : -1,
        'data-annotation-id': a.id,
        onFocus: () => st().select(a.id),
        onPointerDown: (e: PointerEvent) => {
          if (e.button !== 0 || editing) return
          st().select(a.id)
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, from: a }
        },
        onPointerMove: (e: PointerEvent) => {
          const d = drag.current
          if (!d) return
          const z = getViewport().zoom
          st().replace(ws, moved(d.from, (e.clientX - d.x) / z, (e.clientY - d.y) / z))
        },
        onPointerUp: () => (drag.current = null),
        onPointerCancel: () => (drag.current = null),
        onDoubleClick: () => a.kind === 'text' && st().setEditing(a.id),
        onKeyDown: (e: KeyboardEvent) => {
          if (editing) return
          const step = e.shiftKey ? 10 : 1
          const arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            st().remove(ws, [a.id])
          } else if (arrow) {
            e.preventDefault()
            st().replace(ws, moved(a, arrow[0]!, arrow[1]!))
          } else if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault()
            const list = st().items[ws] ?? EMPTY
            const next = list[list.findIndex((x) => x.id === a.id) + (e.key === 'PageDown' ? 1 : -1)]
            if (next) document.querySelector<HTMLElement>(`[data-annotation-id="${next.id}"]`)?.focus()
          } else if (e.key === 'Enter' && a.kind === 'text') {
            e.preventDefault()
            st().setEditing(a.id)
          } else if (e.key === 'Escape') {
            st().select(null)
            ;(e.currentTarget as HTMLElement).blur()
          }
        },
      }
    : { tabIndex: -1 }
  const look = { pointerEvents: interactive ? ('auto' as const) : ('none' as const) }

  if (a.kind === 'stroke') {
    const pts = a.points.map((p) => p.join(',')).join(' ')
    return (
      <svg width={1} height={1} className="annotation-svg" aria-hidden={!interactive}>
        <polyline points={pts} fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round" />
        {/* a wider invisible line so a thin stroke is easy to grab */}
        <polyline className="annotation-item" role="img" aria-label={NAMES.stroke} points={pts} fill="none" stroke="transparent" strokeWidth={Math.max(a.width, 14)} strokeLinecap="round" style={{ pointerEvents: interactive ? 'stroke' : 'none', cursor: 'move' }} {...props} />
      </svg>
    )
  }
  if (a.kind === 'shape') {
    return <div className="annotation-item" role="img" aria-label={a.shape === 'rect' ? 'Rectangle' : 'Ellipse'} style={{ ...boxStyle(a), ...look, border: `2px solid ${a.color}`, background: `${a.color}22`, borderRadius: a.shape === 'ellipse' ? '50%' : 6 }} {...props} />
  }
  if (a.kind === 'text') {
    // a text node, never markup
    return (
      <div className="annotation-item annotation-text" role="note" aria-label={NAMES.text} style={{ ...boxStyle(a), ...look, color: a.color }} {...props}>
        {editing ? <Editor a={a} ws={ws} /> : a.text}
      </div>
    )
  }
  return (
    <div className="annotation-item" role="img" aria-label={NAMES.image} style={{ ...boxStyle(a), ...look }} {...props}>
      <img src={imageSrc(a.imageId)} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none', userSelect: 'none' }} />
    </div>
  )
})

/** The box around the selected annotation, with a handle on each corner for what can be resized (images keep their proportions). */
function Selection({ a, ws }: { a: Annotation; ws: string }) {
  const zoom = useStore((s) => s.transform[2])
  const from = useRef<{ x: number; y: number; a: Annotation } | null>(null)
  const b = boundsOf(a)
  const pad = 4 / zoom
  const size = 10 / zoom
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    from.current = { x: e.clientX, y: e.clientY, a }
  }
  const move = (c: Corner) => (e: PointerEvent) => {
    const f = from.current
    if (!f || f.a.kind === 'stroke') return
    const box = boundsOf(f.a)
    replaceAt(ws, { ...f.a, ...resizedBox(box, c, (e.clientX - f.x) / zoom, (e.clientY - f.y) / zoom, f.a.kind === 'image' ? box.w / box.h : undefined) })
  }
  return (
    <div className="annotation-selection" style={{ left: b.x - pad, top: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, borderWidth: 1.5 / zoom }} data-testid="annotation-selection">
      {a.kind !== 'stroke' &&
        CORNERS.map((c) => (
          <span
            key={c}
            className="annotation-handle"
            data-corner={c}
            onPointerDown={down}
            onPointerMove={move(c)}
            onPointerUp={() => (from.current = null)}
            onPointerCancel={() => (from.current = null)}
            style={{ width: size, height: size, [c.includes('w') ? 'left' : 'right']: -size / 2, [c.includes('n') ? 'top' : 'bottom']: -size / 2, cursor: CURSORS[c] }}
          />
        ))}
    </div>
  )
}
const replaceAt = (ws: string, a: Annotation) => useAnnotations.getState().replace(ws, a)

function Items() {
  const ws = useCanvas((s) => s.activeWorkspace)
  const items = useAnnotations((s) => s.items[ws] ?? EMPTY)
  const draft = useAnnotations((s) => s.draft)
  const interactive = useAnnotations((s) => s.tool === 'select')
  const selected = useAnnotations((s) => s.selected)
  const rf = useReactFlow()
  useEffect(() => {
    bindFlow(rf)
    return () => bindFlow(null)
  }, [rf])
  const current = interactive && selected ? items.find((a) => a.id === selected) : undefined
  const stopId = current?.id ?? items.at(-1)?.id
  return (
    <div className="annotation-layer nopan nodrag" role="group" aria-label="Board annotations" data-testid="annotation-layer">
      {items.map((a) => (
        <Item key={a.id} a={a} ws={ws} interactive={interactive} stop={a.id === stopId} />
      ))}
      {draft && <Item key="draft" a={draft} ws={ws} interactive={false} stop={false} />}
      {current && <Selection a={current} ws={ws} />}
    </div>
  )
}

/**
 * Annotations live inside the canvas viewport (so they follow pan and zoom) but behind the nodes and edges: the layer is portalled
 * into the viewport element and sits at a negative z-index. One layer for the whole board, not one canvas node per annotation.
 */
export function AnnotationLayer() {
  const domNode = useStore((s) => s.domNode)
  const [host, setHost] = useState<Element | null>(null)
  useEffect(() => setHost(domNode?.querySelector('.react-flow__viewport') ?? null), [domNode])
  return host ? createPortal(<Items />, host) : null
}

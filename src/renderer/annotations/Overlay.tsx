import { useEffect, useRef } from 'react'
import { MIN_BOX, STROKE_RAW_MAX, type Annotation } from '../../shared/annotation'
import { useCanvas } from '../store'
import { addAnnotation, currentFlow, newNote, newShape } from './actions'
import { hits, simplifyStroke, type Pt } from './geometry'
import { EMPTY, useAnnotations } from './store'

const PEN_WIDTH = 3
const ERASER_REACH = 6 // screen px
const CURSORS = { pen: 'crosshair', shape: 'crosshair', text: 'text', eraser: 'cell' } as const

type Gesture = { kind: 'pen'; id: string; points: Pt[] } | { kind: 'shape'; id: string; from: Pt } | { kind: 'text'; at: Pt } | { kind: 'erase' }

const box = (a: Pt, b: Pt) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.max(1, Math.abs(a[0] - b[0])), h: Math.max(1, Math.abs(a[1] - b[1])) })

/**
 * With a drawing tool active this surface covers the board: it takes every pointer event, so no terminal or card receives a click
 * while drawing. Pan and zoom by wheel keep working (the wheel is handed to the canvas); Space stays with voice; Esc ends the tool.
 */
export function DrawingOverlay() {
  const tool = useAnnotations((s) => s.tool)
  const tick = useAnnotations((s) => s.focusTick)
  const maximized = useCanvas((s) => s.maximized)
  const el = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const visible = tool !== 'select' && maximized === null

  // a maximized card needs its terminal: the tool steps aside
  useEffect(() => {
    if (maximized !== null) useAnnotations.getState().setTool('select')
  }, [maximized])
  useEffect(() => {
    if (visible && tick > 0) el.current?.focus()
  }, [visible, tick])
  useEffect(() => {
    const node = el.current
    if (!node) return
    // the canvas zooms on wheel events at its own element: hand them over
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const { deltaX, deltaY, deltaZ, deltaMode, ctrlKey, shiftKey, altKey, metaKey, clientX, clientY } = e
      document.querySelector('.react-flow__renderer')?.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, deltaZ, deltaMode, ctrlKey, shiftKey, altKey, metaKey, clientX, clientY, bubbles: true, cancelable: true }))
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [visible])

  if (tool === 'select' || maximized !== null) return null

  const at = (e: React.PointerEvent): Pt => {
    const p = currentFlow()?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 }
    return [p.x, p.y]
  }
  const erase = (p: Pt) => {
    const ws = useCanvas.getState().activeWorkspace
    const reach = ERASER_REACH / (currentFlow()?.getViewport().zoom ?? 1)
    const top = [...(useAnnotations.getState().items[ws] ?? EMPTY)].reverse().find((a) => hits(a, p[0], p[1], reach))
    if (top) useAnnotations.getState().remove(ws, [top.id])
  }
  const draw = useAnnotations.getState

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = at(e)
    const { color } = draw()
    if (tool === 'pen') {
      const points: Pt[] = [p] // the gesture and the draft share this array, so each new point shows at once
      gesture.current = { kind: 'pen', id: crypto.randomUUID(), points }
      draw().setDraft({ id: 'draft', kind: 'stroke', color, width: PEN_WIDTH, points })
    } else if (tool === 'shape') {
      gesture.current = { kind: 'shape', id: crypto.randomUUID(), from: p }
    } else if (tool === 'text') gesture.current = { kind: 'text', at: p } // created on release, so the field keeps the focus
    else if (tool === 'eraser') {
      gesture.current = { kind: 'erase' }
      erase(p)
    }
  }

  const move = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const p = at(e)
    const zoom = currentFlow()?.getViewport().zoom ?? 1
    if (g.kind === 'pen') {
      const last = g.points[g.points.length - 1]!
      if (g.points.length >= STROKE_RAW_MAX || Math.hypot(p[0] - last[0], p[1] - last[1]) * zoom < 2) return
      g.points.push(p)
      const d = draw().draft
      if (d?.kind === 'stroke') draw().setDraft({ ...d }) // a new object over the same (grown) array: the draft redraws
    } else if (g.kind === 'shape') {
      draw().setDraft({ ...newShape(box(g.from, p)), id: 'draft' })
    } else if (g.kind === 'erase') erase(p)
  }

  const up = (e: React.PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    const p = at(e)
    const { color } = draw()
    draw().setDraft(null)
    if (g.kind === 'pen') addAnnotation({ id: g.id, kind: 'stroke', color, width: PEN_WIDTH, points: simplifyStroke(g.points) })
    else if (g.kind === 'shape') {
      const b = box(g.from, p)
      if (b.w >= MIN_BOX || b.h >= MIN_BOX) addAnnotation({ ...newShape(b), id: g.id } as Annotation)
    } else if (g.kind === 'text') newNote({ x: g.at[0], y: g.at[1] })
  }

  return (
    <div
      ref={el}
      className="annotation-overlay"
      role="group"
      aria-label={`Drawing surface, ${tool} tool. Press Escape to go back to selection.`}
      tabIndex={-1}
      style={{ cursor: CURSORS[tool] }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        gesture.current = null
        draw().setDraft(null)
      }}
    />
  )
}

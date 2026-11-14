import type { ReactFlowInstance } from '@xyflow/react'
import { ANNOTATIONS_MAX, type Annotation } from '../../shared/annotation'
import { remoteMessage, useCanvas } from '../store'
import { useAnnotations } from './store'

/** The canvas instance, set by the annotation layer (inside the provider) so actions can turn screen points into board points. */
let flow: ReactFlowInstance | null = null
export const bindFlow = (f: ReactFlowInstance | null) => {
  flow = f
}
export const currentFlow = () => flow

const FULL = `This board has ${ANNOTATIONS_MAX} annotations, the most it can hold.`
const SHAPE_SIZE = { w: 200, h: 120 }
const NOTE_SIZE = { w: 240, h: 96 }
const IMAGE_FIT = 480

/** The middle of what is on screen, in board coordinates. */
export function viewCenter(): { x: number; y: number } {
  const el = document.querySelector('.react-flow')
  const r = el?.getBoundingClientRect()
  return flow && r ? flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 }
}

const ws = () => useCanvas.getState().activeWorkspace
const notify = (text: string, tone: 'error' | 'info' = 'error') => useCanvas.getState().notify(text, tone)

/** Adds to the active workspace; says so and returns false when it is full. */
export function addAnnotation(a: Annotation): boolean {
  const ok = useAnnotations.getState().add(ws(), a)
  if (!ok) notify(FULL)
  return ok
}

export function newShape(box: { x: number; y: number; w: number; h: number }): Annotation {
  const { shape, color } = useAnnotations.getState()
  return { id: crypto.randomUUID(), kind: 'shape', shape, color, ...box }
}

/** A text note, already being typed in; the tool goes back to selection so the field can take focus. */
export function newNote(at: { x: number; y: number }): void {
  const a: Annotation = { id: crypto.randomUUID(), kind: 'text', color: useAnnotations.getState().color, x: at.x, y: at.y, ...NOTE_SIZE, text: '' }
  if (!addAnnotation(a)) return
  useAnnotations.setState({ tool: 'select', draft: null, selected: a.id, editing: a.id })
}

/** Enter on the board with the shape or text tool: the item appears in the middle of the view (the keyboard alternative to dragging). */
export function createAtCenter(): void {
  const { tool } = useAnnotations.getState()
  const c = viewCenter()
  if (tool === 'text') newNote({ x: c.x - NOTE_SIZE.w / 2, y: c.y - NOTE_SIZE.h / 2 })
  else if (tool === 'shape') {
    const a = newShape({ x: c.x - SHAPE_SIZE.w / 2, y: c.y - SHAPE_SIZE.h / 2, ...SHAPE_SIZE })
    if (addAnnotation(a)) useAnnotations.setState({ selected: a.id })
  }
}

function placeImage(info: { id: string; width: number; height: number }): void {
  const k = Math.min(1, IMAGE_FIT / Math.max(info.width, info.height))
  const w = Math.max(1, Math.round(info.width * k))
  const h = Math.max(1, Math.round(info.height * k))
  const c = viewCenter()
  const a: Annotation = { id: crypto.randomUUID(), kind: 'image', imageId: info.id, x: c.x - w / 2, y: c.y - h / 2, w, h }
  if (addAnnotation(a)) useAnnotations.setState({ selected: a.id }) // refused when full: the unused file goes with the next start-up cleanup
}

/** Main shows the file dialog (or reads the clipboard), checks and stores the bytes; the renderer gets an id and a size. */
export async function addImage(source: 'pick' | 'paste'): Promise<void> {
  try {
    const { image } = await window.api.invoke(source === 'pick' ? 'image:pick' : 'image:paste', undefined)
    if (image) placeImage(image)
  } catch (e) {
    notify(remoteMessage(e, 'Could not add the image.'))
  }
}

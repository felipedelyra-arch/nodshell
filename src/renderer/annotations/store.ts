import { create } from 'zustand'
import { ANNOTATIONS_MAX, DEFAULT_COLOR, POINTS_TOTAL_MAX, pointsOf, type Annotation } from '../../shared/annotation'

export type Tool = 'select' | 'shape' | 'text' | 'pen' | 'eraser'
export type ShapeKind = 'rect' | 'ellipse'
export const EMPTY: Annotation[] = []

type State = {
  tool: Tool
  shape: ShapeKind
  color: string
  /** the annotations of each workspace, in drawing order (the last is on top); a changed list is a new array */
  items: Record<string, Annotation[]>
  /** what main has saved, by workspace (the same array objects as `items` while nothing changed) */
  saved: Record<string, Annotation[]>
  selected: string | null
  /** the text note being typed in */
  editing: string | null
  /** what the pen or the shape tool is drawing right now (not an item until the pointer is released) */
  draft: Annotation | null
  /** bumped to move the focus onto the drawing surface (a tool chosen with the mouse) */
  focusTick: number
  setTool: (t: Tool) => void
  /** the shape button or R: picks the shape tool; again, switches between rectangle and ellipse */
  pickShape: () => void
  setColor: (c: string) => void
  select: (id: string | null) => void
  setEditing: (id: string | null) => void
  setDraft: (d: Annotation | null) => void
  requestFocus: () => void
  /** false when the workspace is full (count or points) */
  add: (ws: string, a: Annotation) => boolean
  replace: (ws: string, a: Annotation) => void
  remove: (ws: string, ids: string[]) => void
  /** a workspace was closed: its annotations and their image files go */
  dropWorkspace: (ws: string) => void
  /** a project's saved annotations came back (everything shown is replaced; nothing is deleted from disk) */
  load: (list: { workspaceId: string; items: Annotation[] }[]) => void
  markSaved: (ws: string, items: Annotation[]) => void
}

export const useAnnotations = create<State>((set, get) => ({
  tool: 'select',
  shape: 'rect',
  color: DEFAULT_COLOR,
  items: {},
  saved: {},
  selected: null,
  editing: null,
  draft: null,
  focusTick: 0,

  setTool: (tool) => set((s) => (s.tool === tool ? s : { tool, draft: null, ...(tool === 'select' ? {} : { selected: null }) })),
  pickShape: () => set((s) => (s.tool === 'shape' ? { shape: s.shape === 'rect' ? 'ellipse' : 'rect' } : { tool: 'shape', draft: null, selected: null })),
  setColor: (color) => set({ color }),
  select: (selected) => set((s) => (s.selected === selected ? s : { selected })),
  setEditing: (editing) => set({ editing }),
  setDraft: (draft) => set({ draft }),
  requestFocus: () => set((s) => ({ focusTick: s.focusTick + 1 })),

  add: (ws, a) => {
    const list = get().items[ws] ?? EMPTY
    if (list.length >= ANNOTATIONS_MAX || pointsOf(list) + pointsOf([a]) > POINTS_TOTAL_MAX) return false
    set((s) => ({ items: { ...s.items, [ws]: [...list, a] } }))
    return true
  },

  replace: (ws, a) => set((s) => ({ items: { ...s.items, [ws]: (s.items[ws] ?? EMPTY).map((x) => (x.id === a.id ? a : x)) } })),

  remove: (ws, ids) => {
    const gone = (get().items[ws] ?? EMPTY).filter((a) => ids.includes(a.id))
    if (gone.length === 0) return
    set((s) => ({
      items: { ...s.items, [ws]: (s.items[ws] ?? EMPTY).filter((a) => !ids.includes(a.id)) },
      ...(s.selected && ids.includes(s.selected) ? { selected: null } : {}),
      ...(s.editing && ids.includes(s.editing) ? { editing: null } : {}),
    }))
  },

  dropWorkspace: (ws) => {
    get().remove(ws, (get().items[ws] ?? EMPTY).map((a) => a.id))
    set((s) => ({ items: Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== ws)), saved: Object.fromEntries(Object.entries(s.saved).filter(([k]) => k !== ws)) }))
  },

  load: (list) => {
    const items = Object.fromEntries(list.map((w) => [w.workspaceId, w.items]))
    set({ items, saved: { ...items }, selected: null, editing: null, draft: null })
  },

  markSaved: (ws, items) => set((s) => ({ saved: { ...s.saved, [ws]: items } })),
}))

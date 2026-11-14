import type { ChannelInput } from '../../shared/ipc/channels'
import { EMPTY, useAnnotations } from '../annotations/store'
import { useCanvas } from '../store'

/** Quiet time before the layout is sent after a change (a drag sends once, at its end). */
export const LAYOUT_DEBOUNCE_MS = 500
const clamp = (v: unknown, lo: number, hi: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0
}
const coord = (v: unknown) => clamp(v, -1_000_000, 1_000_000)

/** The renderer's part of the board, as main accepts it: ids, places, sizes, pins, collapsed groups, workspaces and viewports. */
export function layoutOf(s: ReturnType<typeof useCanvas.getState>): ChannelInput<'board:saveLayout'> {
  return {
    workspaces: s.workspaces.map((w) => {
      const v = s.viewports[w.id] ?? { x: 0, y: 0, zoom: 1 }
      return { id: w.id, name: w.name, viewport: { x: coord(v.x), y: coord(v.y), zoom: clamp(v.zoom, 0.05, 4) || 1 } }
    }),
    active: s.activeWorkspace,
    nodes: s.nodes.flatMap((n) => {
      const ws = n.data.workspaceId
      if (!ws) return []
      return [{ id: n.id, workspaceId: ws, x: coord(n.position.x), y: coord(n.position.y), w: clamp(n.width ?? n.style?.width, 0, 100_000), h: clamp(n.height ?? n.style?.height, 0, 100_000), pinned: n.type === 'terminal' && !!n.data.pinned, collapsed: n.type === 'group' && n.data.collapsed }]
    }),
  }
}

/** Sends each workspace's annotations that changed since main last had them (a note still empty is not worth saving). */
function sendAnnotations(force: boolean): void {
  const s = useCanvas.getState()
  if (!s.repo || (s.restoring && !force)) return
  const a = useAnnotations.getState()
  for (const w of s.workspaces) {
    const items = a.items[w.id] ?? EMPTY
    if (items === (a.saved[w.id] ?? EMPTY)) continue
    a.markSaved(w.id, items)
    void window.api
      .invoke('annotations:save', { workspaceId: w.id, items: items.filter((x) => x.kind !== 'text' || x.text.trim() !== '') })
      .catch(() => useAnnotations.getState().markSaved(w.id, a.saved[w.id] ?? EMPTY)) // tried again with the next change
  }
}

/** Sends the layout and the annotations to main after changes (debounced) and right away when main is about to save for good. */
export function startLayoutSaver(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let atimer: ReturnType<typeof setTimeout> | undefined
  const send = (force: boolean) => {
    clearTimeout(timer)
    timer = undefined
    const s = useCanvas.getState()
    if (!s.repo || (s.restoring && !force)) return
    void window.api.invoke('board:saveLayout', layoutOf(s)).catch(() => undefined)
  }
  const asend = () => {
    clearTimeout(atimer)
    atimer = undefined
    sendAnnotations(false)
  }
  const unsubA = useAnnotations.subscribe((s, p) => {
    if (s.items === p.items) return
    clearTimeout(atimer)
    atimer = setTimeout(asend, LAYOUT_DEBOUNCE_MS)
  })
  const unsub = useCanvas.subscribe((s, p) => {
    if (s.repo !== p.repo && s.repo) {
      clearTimeout(atimer)
      atimer = setTimeout(asend, LAYOUT_DEBOUNCE_MS) // drawings made before a project was open are saved with it
    }
    if (s.nodes === p.nodes && s.workspaces === p.workspaces && s.activeWorkspace === p.activeWorkspace && s.viewports === p.viewports && s.repo === p.repo) return
    clearTimeout(timer)
    timer = setTimeout(() => send(false), LAYOUT_DEBOUNCE_MS)
  })
  // the annotations go first: main answers the flush when the layout arrives
  const off = window.api.on('board:flush', () => (sendAnnotations(true), send(true)))
  return () => {
    unsubA()
    unsub()
    off()
    clearTimeout(timer)
    clearTimeout(atimer)
  }
}

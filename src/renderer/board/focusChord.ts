import { inWorkspace } from '../graph'
import { useCanvas } from '../store'

export const isFocusChord = (e: KeyboardEvent) => e.code === 'KeyF' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey

/**
 * Ctrl+Shift+F, the one handler for terminals and web tiles. A node is maximized: restore it, nothing else. Otherwise maximize the node with keyboard
 * focus inside it, else the single selected node; with none or several, do nothing. Capture phase: the chord never reaches a terminal or a field.
 */
export function startFocusChord(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!isFocusChord(e)) return
    const s = useCanvas.getState()
    const t = e.target instanceof Element ? e.target : null
    let next: string | null | undefined
    if (s.maximized !== null) next = null
    else {
      const focused = t?.closest('.react-flow__node')?.getAttribute('data-id')
      const selected = inWorkspace(s.nodes, s.activeWorkspace).filter((n) => n.selected)
      const pick = focused ?? (selected.length === 1 ? selected[0]?.id : undefined)
      if (pick && s.nodes.some((n) => n.id === pick && (n.type === 'terminal' || n.type === 'webtile'))) next = pick
    }
    if (next === undefined) return
    e.preventDefault()
    e.stopPropagation() // not typed into a terminal or a field
    if (!e.repeat) s.setMaximized(next)
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}

import { useSyncExternalStore } from 'react'

/** Whether the edges' dots may move: 'on', 'off' (window blurred or hidden: nobody sees them) or 'reduced' (no motion at all). */
export type Motion = 'on' | 'off' | 'reduced'

// shortcut: the window counts as focused until its first blur (no event tells the state at start); a hasFocus() poll would cost more
let focused = true
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => f())
const reduce = matchMedia('(prefers-reduced-motion: reduce)')
let listening = false

function subscribe(f: () => void): () => void {
  if (!listening) {
    listening = true
    reduce.addEventListener('change', notify)
    addEventListener('blur', () => ((focused = false), notify()))
    addEventListener('focus', () => ((focused = true), notify()))
    document.addEventListener('visibilitychange', notify)
  }
  subs.add(f)
  return () => void subs.delete(f)
}

const snapshot = (): Motion => (reduce.matches ? 'reduced' : focused && !document.hidden ? 'on' : 'off')

export const useMotion = (): Motion => useSyncExternalStore(subscribe, snapshot)

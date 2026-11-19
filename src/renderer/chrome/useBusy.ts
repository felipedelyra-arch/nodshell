import { useCallback, useRef, useState } from 'react'

/**
 * An action that waits for an answer: `busy` is true from the call until it settles (the control shows aria-busy), and a second
 * call made meanwhile is dropped, so the action cannot be triggered twice.
 */
export function useBusy(): [boolean, (fn: () => unknown) => Promise<void>] {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const run = useCallback(async (fn: () => unknown) => {
    if (lock.current) return
    lock.current = true
    try {
      const r = fn()
      if (!(r instanceof Promise)) return
      setBusy(true)
      await r.catch(() => undefined) // the action reports its own failure
    } finally {
      lock.current = false
      setBusy(false)
    }
  }, [])
  return [busy, run]
}

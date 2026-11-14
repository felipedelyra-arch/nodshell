import { useEffect, useState } from 'react'

/** Version and the diagnostics text from main; null until loaded or if main refuses. */
export function useDiagnostics(): { version: string; text: string } | null {
  const [d, setD] = useState<{ version: string; text: string } | null>(null)
  useEffect(() => {
    let live = true
    window.api.invoke('app:diagnostics', undefined).then((r) => live && setD(r), () => undefined)
    return () => {
      live = false
    }
  }, [])
  return d
}

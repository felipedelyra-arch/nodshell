import type { Terminal } from '@xterm/xterm'
import { useEffect, useState, type RefObject } from 'react'

const POLL_MS = 600 // at most ~2 reads a second per card
const LINES = 8
const COLS = 200

/** The last non-empty lines of the live xterm's buffer, as plain text (format and control characters removed). */
function lastLines(term: Terminal | null): string {
  if (!term) return ''
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = buf.baseY + term.rows - 1; i >= 0 && out.length < LINES; i--) {
    const l = (buf.getLine(i)?.translateToString(true) ?? '').replace(/[\p{Cf}\p{Cc}]/gu, '').slice(0, COLS)
    if (l.trim() !== '') out.push(l)
  }
  return out.reverse().join('\n')
}

/** Zoomed-out terminal body: the xterm stays alive (hidden, still receiving output); this shows its tail. Rendered as text, never HTML. */
export function TailPreview({ term, exited }: { term: RefObject<Terminal | null>; exited: boolean }) {
  const [text, setText] = useState(() => lastLines(term.current))
  useEffect(() => {
    const read = () => setText(lastLines(term.current))
    read()
    if (exited) return
    const t = setInterval(read, POLL_MS)
    return () => clearInterval(t)
  }, [term, exited])
  return (
    <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre border-t border-white/10 bg-background p-2 font-mono text-[12px] leading-snug text-muted" data-testid="terminal-preview" aria-label="Last lines of output">
      {text}
    </pre>
  )
}

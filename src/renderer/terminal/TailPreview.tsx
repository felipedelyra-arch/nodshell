import type { Terminal } from '@xterm/xterm'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const POLL_MS = 600 // at most ~2 reads a second per card
const MAX_LINES = 6
const COLS = 200
// on-screen sizes in px, whatever the board zoom
const NAME_PX = 14
const SMALL_PX = 11
const PAD = 8

/** The last non-empty lines of the live xterm's buffer, as plain text (format and control characters removed). */
function lastLines(term: Terminal | null): string[] {
  if (!term) return []
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = buf.baseY + term.rows - 1; i >= 0 && out.length < MAX_LINES; i--) {
    const l = (buf.getLine(i)?.translateToString(true) ?? '').replace(/[\p{Cf}\p{Cc}]/gu, '').slice(0, COLS)
    if (l.trim() !== '') out.push(l)
  }
  return out.reverse()
}

/**
 * Zoomed-out terminal body: the xterm stays alive (hidden, still receiving output); this shows name, status and the tail of its output.
 * Counter-scaled by 1/zoom so the text has the same on-screen size at any zoom. Rendered as text, never HTML.
 */
export function TailPreview({ term, exited, name, status, zoom }: { term: RefObject<Terminal | null>; exited: boolean; name: string; status: string; zoom: number }) {
  const [lines, setLines] = useState(() => lastLines(term.current))
  useEffect(() => {
    const read = () => setLines((old) => {
      const next = lastLines(term.current)
      return next.length === old.length && next.every((l, i) => l === old[i]) ? old : next
    })
    read()
    if (exited) return
    const t = setInterval(read, POLL_MS)
    return () => clearInterval(t)
  }, [term, exited])

  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 }) // layout px of the body, before the board scale
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const w = size.w * zoom
  const h = size.h * zoom // on-screen px
  const fit = Math.floor((h - 2 * PAD - 18 - 14 - 4) / 14) // rows left under the name and status lines
  const shown = lines.slice(Math.max(0, lines.length - Math.min(MAX_LINES, Math.max(0, fit))))
  const label = `${name}, ${status}${lines.length ? `, last output: ${lines.slice(-3).join(' ').replace(/\s+/g, ' ').trim()}` : ''}`
  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden border-t border-white/10 bg-background" data-testid="terminal-preview" role="group" aria-label={label} title="Double-click to open">
      <div className="absolute left-0 top-0 origin-top-left overflow-hidden" style={{ width: w, height: h, padding: PAD, boxSizing: 'border-box', transform: `scale(${1 / zoom})` }}>
        <div className="truncate font-bold text-text" style={{ fontSize: NAME_PX, lineHeight: '18px' }} data-testid="summary-name">{name}</div>
        <div className="truncate text-muted" style={{ fontSize: SMALL_PX, lineHeight: '14px' }} data-testid="summary-status">{status}</div>
        {shown.length > 0 && (
          <div className="mt-1 font-mono text-muted" style={{ fontSize: SMALL_PX, lineHeight: '14px' }} data-testid="summary-lines">
            {shown.map((l, i) => (
              <div key={i} className="truncate whitespace-pre">{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

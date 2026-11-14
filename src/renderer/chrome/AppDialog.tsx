import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'

/** Small modal: Esc and the backdrop close it (`backdropCloses={false}`: only Esc and its buttons), Tab stays inside; the opener restores focus in `onClose`. */
export function AppDialog({ label, onClose, children, className = '', backdropCloses = true }: { label: string; onClose: () => void; children: ReactNode; className?: string; backdropCloses?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => root.current?.querySelector<HTMLElement>('button')?.focus(), [])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !root.current) return
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const wrapTo = e.shiftKey && document.activeElement === first ? last : !e.shiftKey && document.activeElement === last ? first : null
    if (wrapTo) {
      e.preventDefault()
      wrapTo.focus()
    }
  }
  // in <body>: rendered inside a positioned bar, the backdrop would sit below the rest of the chrome
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => backdropCloses && e.target === e.currentTarget && onClose()}>
      <div ref={root} role="dialog" aria-modal="true" aria-label={label} className={`modal chrome-modal ${className}`} onKeyDown={onKeyDown}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">{label}</h2>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

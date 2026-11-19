import type { ReactNode } from 'react'

/** An inline "are you sure": the question says what is lost; focus starts on the way back, and Esc is handled by the owner. */
export function ConfirmRow({ label, children, keep = 'Keep', confirm, busy, onKeep, onConfirm, className = '' }: { label: string; children: ReactNode; keep?: string; confirm: string; busy?: boolean; onKeep: () => void; onConfirm: () => void; className?: string }) {
  return (
    <div className={`confirm-row ${className}`} role="alertdialog" aria-label={label}>
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" className="btn-quiet" autoFocus onClick={onKeep}>
        {keep}
      </button>
      <button type="button" className="btn-danger" aria-busy={busy || undefined} onClick={() => !busy && onConfirm()}>
        {confirm}
      </button>
    </div>
  )
}

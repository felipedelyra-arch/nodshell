import { useEffect, useId, useRef, useState } from 'react'
import { ADDRESS_MAX, DEFAULT_ADDRESS } from '../../shared/webtile'
import { useCanvas } from '../store'

/** Asks for the address of a new web tile (main validates it: http or https only). */
export function WebTilePopover({ onClose, anchor }: { onClose: () => void; anchor: React.RefObject<HTMLButtonElement | null> }) {
  const [address, setAddress] = useState(DEFAULT_ADDRESS)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const ids = useId()

  useEffect(() => input.current?.select(), []) // once: the parent re-renders (and passes a new onClose) while this is open
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [onClose, anchor])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    const err = await useCanvas.getState().addWebTile(address)
    setBusy(false)
    if (err) setProblem(err)
    else onClose()
  }

  return (
    <form
      ref={box}
      role="dialog"
      aria-label="New web tile"
      className="tool-popover"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <label className="field-label" htmlFor={`${ids}-address`}>
        Address
      </label>
      <input
        ref={input}
        id={`${ids}-address`}
        className="field"
        spellCheck={false}
        maxLength={ADDRESS_MAX}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${ids}-hint`}
        value={address}
        onChange={(e) => {
          setAddress(e.target.value)
          setProblem(null)
        }}
      />
      <p id={`${ids}-hint`} className={`field-hint ${problem ? 'field-hint-error' : ''}`} role={problem ? 'alert' : undefined}>
        {problem ?? 'A live page on the board: localhost preview or any http(s) address. F6 in the page returns to the app.'}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-accent" disabled={busy || address.trim() === ''}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      </div>
    </form>
  )
}

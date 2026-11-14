import { useEffect, useId, useRef, useState } from 'react'
import { CONTROL_RE, GROUP_NAME_MAX } from '../../shared/preset'
import { useCanvas } from '../store'

export function GroupPopover({ onClose }: { onClose: () => void }) {
  const createGroup = useCanvas((s) => s.createGroup)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const ids = useId()
  const trimmed = name.trim()
  const valid = trimmed.length >= 1 && trimmed.length <= GROUP_NAME_MAX && !CONTROL_RE.test(trimmed)

  useEffect(() => input.current?.focus(), [])

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    const ok = await createGroup(trimmed)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <form
      role="dialog"
      aria-label="New group"
      className="popover pointer-events-auto"
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
      <label className="field-label" htmlFor={`${ids}-name`}>
        Group name
      </label>
      <input ref={input} id={`${ids}-name`} className="field" value={name} maxLength={GROUP_NAME_MAX} autoComplete="off" spellCheck={false} placeholder="e.g. Checkout" onChange={(e) => setName(e.target.value)} />
      <p className="field-hint">Groups the selected cards. A card can only be in one group.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-accent" disabled={!valid || busy}>
          {busy ? 'Grouping…' : 'Create group'}
        </button>
      </div>
    </form>
  )
}

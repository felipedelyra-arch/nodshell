import { useEffect, useId, useRef, useState } from 'react'
import { usePresets } from '../presets/store'
import { useCanvas } from '../store'

export function SpawnPopover({ onClose }: { onClose: () => void }) {
  const presets = usePresets((s) => s.presets)
  const count = useCanvas((s) => s.spawnCount)
  const setCount = useCanvas((s) => s.setSpawnCount)
  const liveLimit = useCanvas((s) => s.liveLimit)
  const spawnMany = useCanvas((s) => s.spawnMany)
  const [presetId, setPresetId] = useState('')
  const [busy, setBusy] = useState(false)
  const select = useRef<HTMLSelectElement>(null)
  const ids = useId()
  const chosen = presets.find((p) => p.id === presetId) ?? presets[0]

  useEffect(() => {
    select.current?.focus()
    void usePresets.getState().load() // presets may have changed since startup
  }, [])

  const submit = async () => {
    if (!chosen || busy) return
    setBusy(true)
    const ok = await spawnMany(chosen.id, count)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <form
      role="dialog"
      aria-label="Spawn agents"
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
      <label className="field-label" htmlFor={`${ids}-preset`}>
        Preset
      </label>
      <select ref={select} id={`${ids}-preset`} className="field" value={chosen?.id ?? ''} onChange={(e) => setPresetId(e.target.value)}>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <span className="field-label" id={`${ids}-count`}>
        Agents
      </span>
      <div className="flex items-center gap-2" role="group" aria-labelledby={`${ids}-count`}>
        <button type="button" className="btn-quiet" aria-label="Fewer agents" disabled={count <= 1} onClick={() => setCount(count - 1)}>
          −
        </button>
        <output className="w-8 text-center text-sm text-text" data-testid="spawn-count" aria-live="polite">
          {count}
        </output>
        <button type="button" className="btn-quiet" aria-label="More agents" disabled={count >= liveLimit} onClick={() => setCount(count + 1)}>
          +
        </button>
      </div>
      <p className="field-hint">Each agent gets its own worktree, in one group.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-accent" disabled={!chosen || busy}>
          {busy ? 'Starting…' : `Spawn ${count}`}
        </button>
      </div>
    </form>
  )
}

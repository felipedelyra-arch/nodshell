import { useId, useState } from 'react'
import { LIVE_HARD_MAX, LIVE_LIMIT_MIN } from '../../shared/agent'
import { useCanvas } from '../store'
import { AppDialog } from './AppDialog'
import { useDiagnostics } from './useDiagnostics'

const SHORTCUTS: [string, string][] = [
  ['Shift + click', 'add a card to the selection'],
  ['Shift + drag', 'select cards with a box'],
  ['Ctrl + Enter', 'send the prompt (card details)'],
  ['Esc', 'close a dialog, popover or expanded card'],
]

/** The live-terminal limit: saved by main (validated there too); lowering it stops nothing that already runs. */
function LiveLimitField() {
  const limit = useCanvas((s) => s.liveLimit)
  const [text, setText] = useState(String(limit))
  const [note, setNote] = useState('')
  const id = useId()
  const n = Number(text)
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= LIVE_LIMIT_MIN && n <= LIVE_HARD_MAX
  const save = () =>
    window.api.invoke('settings:setLiveLimit', { limit: n }).then(
      (r) => {
        useCanvas.getState().setLiveLimit(r.liveLimit)
        setNote('Saved')
      },
      () => setNote('Could not save'),
    )
  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void save()
      }}
    >
      <label className="field-label" htmlFor={id}>
        Live terminal limit ({LIVE_LIMIT_MIN} to {LIVE_HARD_MAX})
      </label>
      <div className="flex items-center gap-2">
        <input id={id} type="number" min={LIVE_LIMIT_MIN} max={LIVE_HARD_MAX} step={1} className="field w-20" value={text} aria-invalid={!valid} onChange={(e) => (setText(e.target.value), setNote(''))} />
        <button type="submit" className="btn-accent" disabled={!valid}>
          Save
        </button>
        <span role="status" className="text-xs text-muted">
          {note}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">Lowering it does not close running terminals; it only blocks new ones.</p>
    </form>
  )
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const d = useDiagnostics()
  return (
    <AppDialog label="About" onClose={onClose}>
      <p className="mt-3 text-sm text-text">
        Agent Canvas <span className="font-mono text-muted">{d ? d.version : ''}</span>
      </p>
      <LiveLimitField />
      <h3 className="field-label">Keyboard shortcuts</h3>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-white">{k}</dt>
            <dd className="m-0 text-text">{v}</dd>
          </div>
        ))}
      </dl>
    </AppDialog>
  )
}

export function BugDialog({ onClose }: { onClose: () => void }) {
  const d = useDiagnostics()
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const copy = () => window.api.invoke('app:copyDiagnostics', undefined).then(() => setCopied('ok'), () => setCopied('fail'))
  return (
    <AppDialog label="Found a bug?" onClose={onClose}>
      <p className="mt-3 text-xs text-muted">Copy this diagnostic and paste it in your report. It stays on this machine: no paths, names or terminal content.</p>
      <pre className="last-text mt-2 font-mono" tabIndex={0} aria-label="Diagnostic">
        {d ? d.text : 'Loading…'}
      </pre>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className="btn-accent" disabled={!d} onClick={() => void copy()}>
          Copy
        </button>
        <span role="status" className="text-xs text-muted">
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Could not copy' : ''}
        </span>
      </div>
    </AppDialog>
  )
}

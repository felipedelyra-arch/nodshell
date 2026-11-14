import { useId, useState } from 'react'
import { BRIEFING_MAX } from '../../shared/handoff'
import { AppDialog } from '../chrome/AppDialog'
import { remoteMessage, useCanvas, type HandoffDto } from '../store'

/** The briefing the outgoing agent wrote, editable; only Send delivers it (one prompt), Cancel, Close or Esc discard it. */
export function HandoffDialog({ handoff }: { handoff: HandoffDto }) {
  const nodes = useCanvas((s) => s.nodes)
  const notify = useCanvas((s) => s.notify)
  const [text, setText] = useState(handoff.briefing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sizeId = useId()
  const nameOf = (id: string) => {
    const d = nodes.find((n) => n.id === id)?.data
    return d && 'name' in d ? d.name : 'agent'
  }
  const from = nameOf(handoff.fromId)
  const to = nameOf(handoff.toId)
  const over = text.length > BRIEFING_MAX

  // main drops the handoff on Send or Cancel; its event then unmounts this dialog
  const cancel = () => void window.api.invoke('handoff:cancel', { id: handoff.id }).catch(() => undefined)
  const send = async () => {
    if (busy || over || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      const { result } = await window.api.invoke('handoff:send', { id: handoff.id, text })
      notify(`${result}.`, 'info')
    } catch (e) {
      setError(remoteMessage(e, 'Could not send the handoff.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppDialog label={`Hand off ${from} → ${to}`} onClose={busy ? () => undefined : cancel} backdropCloses={false} className="memory-modal">
      <p className="mt-2 text-xs text-muted">
        {from} wrote this briefing. Edit it if needed: only Send delivers it to {to}, as one prompt with a header naming {from}.
      </p>
      <textarea
        className="memory-text mt-3"
        data-testid="handoff-text"
        aria-label="Briefing"
        aria-describedby={sizeId}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <p id={sizeId} data-testid="handoff-size" className={`m-0 mt-2 text-right font-mono text-xs ${over ? 'text-[#ffa47e]' : 'text-muted'}`}>
        {text.length} / {BRIEFING_MAX} characters{over ? ', too long' : ''}
      </p>
      {error && (
        <p role="alert" className="text-xs text-[#ffa47e]">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn-accent" disabled={busy || over || !text.trim()} onClick={() => void send()}>
          Send
        </button>
        <button type="button" className="btn-quiet" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
    </AppDialog>
  )
}

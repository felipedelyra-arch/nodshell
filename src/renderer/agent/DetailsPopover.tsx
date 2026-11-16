import { useEffect, useId, useRef, useState } from 'react'
import { PROMPT_MAX } from '../../shared/agent'
import { ConnectMenu } from '../flow/ConnectMenu'
import { HandoffSection } from './HandoffSection'
import { LoopSection } from './LoopSection'
import type { AgentInfo } from '../graph'
import { useCanvas, type LastMessage } from '../store'

export const NO_STATUS = 'Live status is unavailable. Check in the terminal that Claude is ready before sending.'
export const STARTING = 'Answer the dialog in the terminal first'
export const WAITING = 'Answer in the terminal first'

const SOURCE: Record<LastMessage['source'], string> = {
  transcript: 'From the session transcript',
  scrape: 'Best effort · scraped from the terminal',
  none: 'No message yet',
}

function useElapsed(since: number, running: boolean): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

type Props = { ptyId: string; name: string; agent: AgentInfo; startedAt: number; running: boolean; workspaceId?: string; onClose: () => void }

/** Opened from the card's name: role, model, branch, elapsed time, the last message, the prompt box, the agent's loop and its handoff. */
export function DetailsPopover({ ptyId, name, agent, startedAt, running, workspaceId, onClose }: Props) {
  const lastMessage = useCanvas((s) => s.lastMessage)
  const sendPrompt = useCanvas((s) => s.sendPrompt)
  const [msg, setMsg] = useState<LastMessage | null | undefined>(undefined)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const lastText = useRef<HTMLDivElement>(null)
  const hint = useId()
  const sourceId = useId()
  const elapsed = useElapsed(startedAt, running)
  // while starting an Enter could answer the trust dialog; only allowed once live status is known to be unavailable
  const starting = agent.state === 'starting' && !agent.statusUnavailable
  // "needs you": it may show a permission dialog, whose highlighted answer an Enter would pick
  const waiting = agent.state === 'waiting'
  const canSend = running && !starting && !waiting
  const note = !running ? 'The agent has exited.' : starting ? STARTING : waiting ? WAITING : agent.statusUnavailable ? NO_STATUS : undefined

  useEffect(() => {
    let live = true
    void lastMessage(ptyId).then((m) => live && setMsg(m))
    return () => void (live = false)
  }, [ptyId, lastMessage])
  useEffect(() => (canSend ? area.current : lastText.current)?.focus(), [])

  const send = async () => {
    if (!canSend || !text.trim() || busy) return
    setBusy(true)
    const ok = await sendPrompt(ptyId, text)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <div
      className="details-box nodrag nowheel nopan"
      role="dialog"
      aria-label={`Details for ${name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <dl className="details-grid">
        <dt>Role</dt>
        <dd>{agent.role}</dd>
        <dt>Model</dt>
        <dd>{agent.model}</dd>
        <dt>Branch</dt>
        <dd className="truncate" title={agent.branch}>
          {agent.branch || 'project folder'}
        </dd>
        <dt>Elapsed</dt>
        <dd>{elapsed}</dd>
        {agent.report && (
          <>
            <dt>Status</dt>
            <dd className="col-span-3 truncate" title={agent.report} data-testid="agent-report">
              {agent.report}
            </dd>
          </>
        )}
      </dl>
      <ConnectMenu source={{ kind: 'agent', id: ptyId }} workspaceId={workspaceId} />
      <p id={sourceId} className="field-hint m-0" data-testid="last-source" data-source={msg?.source ?? ''}>
        Last message · {msg === undefined ? 'Loading…' : msg === null ? 'Unavailable' : SOURCE[msg.source]}
      </p>
      <div ref={lastText} tabIndex={0} className="last-text" aria-label={`Last message text from ${name}`} aria-busy={msg === undefined} data-testid="last-text">
        {msg?.text ?? ''}
      </div>
      <textarea
        ref={area}
        className="field min-h-0 shrink-0 resize-none font-mono text-[11px]"
        rows={3}
        maxLength={PROMPT_MAX}
        value={text}
        disabled={!canSend}
        aria-label={`Prompt for ${name}`}
        aria-describedby={hint}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="flex items-center gap-2">
        <p id={hint} className={`field-hint m-0 flex-1 ${note ? 'field-hint-error' : ''}`} data-testid="prompt-hint">
          {note ? `${note}${canSend ? ' Ctrl+Enter sends · Esc closes.' : ''}` : 'Ctrl+Enter sends · Esc closes. If Claude asks to trust the folder, answer it in the terminal first.'}
        </p>
        <button type="button" className="btn-accent" disabled={!canSend || !text.trim() || busy} onClick={() => void send()}>
          Send
        </button>
      </div>
      <LoopSection agentId={ptyId} name={name} workspaceId={workspaceId} running={running} />
      <HandoffSection agentId={ptyId} name={name} agent={agent} workspaceId={workspaceId} />
    </div>
  )
}

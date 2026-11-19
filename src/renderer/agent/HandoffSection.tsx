import { useId, useMemo, useState } from 'react'
import { inWorkspace, isAlive, isTerminal, type AgentInfo } from '../graph'
import { remoteMessage, useCanvas } from '../store'

/** Hand off, inside the agent's details: pick another agent of this board; the agent then writes its briefing for the dialog. */
export function HandoffSection({ agentId, name, agent, workspaceId }: { agentId: string; name: string; agent: AgentInfo; workspaceId?: string }) {
  const nodes = useCanvas((s) => s.nodes)
  const paused = useCanvas((s) => s.paused)
  const handoff = useCanvas((s) => s.handoffs.find((h) => h.fromId === agentId))
  const notify = useCanvas((s) => s.notify)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const ids = { to: useId(), hint: useId() }
  // other agents of the same board, the Orchestrator included; never a console
  const targets = useMemo(() => inWorkspace(nodes, workspaceId).filter(isTerminal).filter((n) => n.id !== agentId && n.data.agent && isAlive(n.data)).map((n) => ({ id: n.id, name: n.data.name })), [nodes, workspaceId, agentId])
  const toId = targets.some((t) => t.id === to) ? to : (targets[0]?.id ?? '')
  const why = paused ? 'Everything is paused, resume all first' : agent.state !== 'idle' ? `${name} must be resting to write its summary` : targets.length === 0 ? 'No other agent on this board' : null

  const call = async (fn: () => Promise<unknown>, fallback: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      notify(remoteMessage(e, fallback), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (handoff) {
    const target = nodes.find((n) => n.id === handoff.toId)?.data
    return (
      <div className="handoff-box handoff-row" data-testid="handoff-section">
        <p role="status" className="field-hint m-0 flex-1" data-testid="handoff-status">
          {handoff.state === 'summarizing' ? `Waiting for ${name}'s summary…` : `Summary ready for ${target && 'name' in target ? target.name : 'the next agent'}`}
        </p>
        <button type="button" className="btn-quiet" disabled={busy} aria-label={`Cancel handoff from ${name}`} onClick={() => void call(() => window.api.invoke('handoff:cancel', { id: handoff.id }), 'Could not cancel the handoff.')}>
          Cancel
        </button>
      </div>
    )
  }
  return (
    <div className="handoff-box" data-testid="handoff-section">
      <div className="handoff-row">
        <label htmlFor={ids.to}>Hand off to</label>
        <select id={ids.to} className="field min-w-0 flex-1 py-0.5" value={toId} disabled={targets.length === 0} onChange={(e) => setTo(e.target.value)}>
          {targets.length === 0 && <option value="">No other agent</option>}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-accent"
          aria-busy={busy || undefined}
          disabled={!!why || !toId}
          aria-describedby={ids.hint}
          onClick={() => void call(() => window.api.invoke('handoff:start', { fromId: agentId, toId }), 'Could not start the handoff.')}
        >
          Hand off
        </button>
      </div>
      <p id={ids.hint} className="field-hint m-0" data-testid="handoff-hint">
        {why ?? `${name} writes a briefing first; nothing reaches the next agent until you send it.`}
      </p>
    </div>
  )
}

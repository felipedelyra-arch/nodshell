import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { PROMPT_MAX } from '../../shared/agent'
import { GOAL_MAX, GOAL_REACHED, IDLE_MAX_SEC, IDLE_MIN_SEC, LOOP_RUNS_DEFAULT, LOOP_RUNS_MAX, OUTPUT_TEXT_MAX, SCHEDULE_MAX_SEC, SCHEDULE_MIN_SEC } from '../../shared/loop'
import { inWorkspace, isTerminal } from '../graph'
import { ConfirmRow } from '../chrome/ConfirmRow'
import { remoteMessage, useCanvas, type LoopDto } from '../store'

type Kind = LoopDto['trigger']['kind']
const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'schedule', label: 'Schedule' },
  { kind: 'idle', label: 'When idle' },
  { kind: 'output', label: 'On console output' },
]
const SECS = { schedule: { min: SCHEDULE_MIN_SEC, max: SCHEDULE_MAX_SEC, label: 'Every (s)' }, idle: { min: IDLE_MIN_SEC, max: IDLE_MAX_SEC, label: 'Idle for (s)' } }

/** "active · 3/20 runs", "paused: why", "done: Goal reached" */
export function loopStatus(l: LoopDto): string {
  return l.state === 'active' ? `active · ${l.runs}/${l.maxRuns} runs` : `${l.state}: ${l.reason ?? (l.state === 'done' ? GOAL_REACHED : 'Paused')}`
}

type Form = { kind: Kind; secs: Record<'schedule' | 'idle', string>; terminalId: string; text: string; prompt: string; goal: string; maxRuns: string }
const formOf = (l?: LoopDto): Form => {
  const t = l?.trigger
  return {
    kind: t?.kind ?? 'idle',
    secs: { schedule: String(t?.kind === 'schedule' ? t.everySec : 300), idle: String(t?.kind === 'idle' ? t.afterSec : 60) },
    terminalId: t?.kind === 'output' ? t.terminalId : '',
    text: t?.kind === 'output' ? t.text : '',
    prompt: l?.prompt ?? '',
    goal: l?.goal ?? '',
    maxRuns: String(l?.maxRuns ?? LOOP_RUNS_DEFAULT),
  }
}
const whole = (v: string, lo: number, hi: number) => /^\d{1,6}$/.test(v) && Number(v) >= lo && Number(v) <= hi

/** The agent's loop, inside its details popover: one prompt repeated by a trigger until a goal or a number of runs. */
export function LoopSection({ agentId, name, workspaceId, running }: { agentId: string; name: string; workspaceId?: string; running: boolean }) {
  const loop = useCanvas((s) => s.loops.find((l) => l.agentId === agentId))
  const nodes = useCanvas((s) => s.nodes)
  const notify = useCanvas((s) => s.notify)
  const setLoops = useCanvas((s) => s.setLoops)
  const [form, setForm] = useState(() => formOf(loop))
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const removeBtn = useRef<HTMLButtonElement>(null)
  // the confirmation is gone: the focus goes back to Remove (after this render shows it again), never to the page
  const keep = () => {
    setConfirming(false)
    requestAnimationFrame(() => removeBtn.current?.focus())
  }
  const ids = { kind: useId(), secs: useId(), term: useId(), text: useId(), prompt: useId(), goal: useId(), runs: useId() }
  // other terminals of the same board, agent or console, by name (never this agent's own: main refuses it)
  const terminals = useMemo(() => inWorkspace(nodes, workspaceId).filter(isTerminal).filter((n) => n.id !== agentId && n.data.status === 'running').map((n) => ({ id: n.id, name: n.data.name })), [nodes, workspaceId, agentId])

  useEffect(() => {
    void window.api.invoke('loop:list', undefined).then(({ loops }) => setLoops(loops), () => undefined)
  }, [setLoops])
  // another loop (or the first one main reports): the form shows it; runs and state updates never overwrite what is being typed
  useEffect(() => setForm(formOf(loop)), [loop?.id])

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const termId = terminals.some((t) => t.id === form.terminalId) ? form.terminalId : (terminals[0]?.id ?? '')
  const secsOk = form.kind === 'output' || whole(form.secs[form.kind], SECS[form.kind].min, SECS[form.kind].max)
  const runsOk = whole(form.maxRuns, 1, LOOP_RUNS_MAX)
  const outputOk = form.kind !== 'output' || (termId !== '' && form.text.trim() !== '')
  const canSave = running && !busy && form.prompt.trim() !== '' && secsOk && runsOk && outputOk

  const call = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      notify(remoteMessage(e, fallback), 'error')
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    if (!canSave) return
    const trigger = form.kind === 'schedule' ? { kind: form.kind, everySec: Number(form.secs.schedule) } : form.kind === 'idle' ? { kind: form.kind, afterSec: Number(form.secs.idle) } : { kind: form.kind, terminalId: termId, text: form.text }
    void call(() => window.api.invoke('loop:set', { agentId, prompt: form.prompt, trigger, goal: form.goal, maxRuns: Number(form.maxRuns) }), 'Could not save the loop.')
  }

  return (
    <details className="loop-box" data-testid="loop-section">
      <summary className="loop-summary">
        Loop · <span data-testid="loop-status">{loop ? loopStatus(loop) : 'off'}</span>
      </summary>
      <div className="loop-grid">
        <label htmlFor={ids.kind}>Trigger</label>
        <select id={ids.kind} className="field py-0.5" value={form.kind} onChange={(e) => set({ kind: e.target.value as Kind })}>
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        {form.kind === 'output' ? (
          <>
            <label htmlFor={ids.term}>Watch</label>
            <select id={ids.term} className="field py-0.5" value={termId} disabled={terminals.length === 0} onChange={(e) => set({ terminalId: e.target.value })}>
              {terminals.length === 0 && <option value="">No terminal on this board</option>}
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <label htmlFor={ids.text}>Contains</label>
            <input id={ids.text} className="field py-0.5" maxLength={OUTPUT_TEXT_MAX} value={form.text} aria-invalid={form.text.trim() === '' || undefined} onChange={(e) => set({ text: e.target.value })} />
          </>
        ) : (
          <>
            <label htmlFor={ids.secs}>{SECS[form.kind].label}</label>
            <input
              id={ids.secs}
              className="field py-0.5"
              type="number"
              min={SECS[form.kind].min}
              max={SECS[form.kind].max}
              value={form.secs[form.kind]}
              aria-invalid={!secsOk || undefined}
              title={`${SECS[form.kind].min} to ${SECS[form.kind].max} seconds`}
              onChange={(e) => set({ secs: { ...form.secs, [form.kind]: e.target.value } })}
            />
          </>
        )}
        <label htmlFor={ids.prompt}>Prompt</label>
        <textarea id={ids.prompt} className="field resize-none" rows={2} maxLength={PROMPT_MAX} value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} />
        <label htmlFor={ids.goal}>Goal</label>
        <input id={ids.goal} className="field py-0.5" maxLength={GOAL_MAX} placeholder="optional · stop when the reply contains" value={form.goal} onChange={(e) => set({ goal: e.target.value })} />
        <label htmlFor={ids.runs}>Max runs</label>
        <input id={ids.runs} className="field py-0.5" type="number" min={1} max={LOOP_RUNS_MAX} value={form.maxRuns} aria-invalid={!runsOk || undefined} onChange={(e) => set({ maxRuns: e.target.value })} />
      </div>
      {confirming && loop && (
        <div
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation() // Esc cancels the confirmation only, not the whole details box
            keep()
          }}
        >
          <ConfirmRow label="Remove loop" confirm="Remove" busy={busy} onKeep={keep} onConfirm={() => void call(() => window.api.invoke('loop:remove', { id: loop.id }), 'Could not remove the loop.').then(() => setConfirming(false))}>
            Remove this loop? Its prompt and trigger are lost.
          </ConfirmRow>
        </div>
      )}
      <div className={`flex items-center gap-2 ${confirming && loop ? 'hidden' : ''}`}>
        <button type="button" className="btn-accent" disabled={!canSave} aria-label={`${loop ? 'Save' : 'Start'} loop of ${name}`} onClick={save}>
          {loop ? 'Save' : 'Start'}
        </button>
        {loop && (
          <>
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => void call(() => window.api.invoke('loop:update', { id: loop.id, paused: loop.state === 'active' }), 'Could not update the loop.')}>
              {loop.state === 'active' ? 'Pause' : 'Resume'}
            </button>
            <button ref={removeBtn} type="button" className="btn-danger" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </button>
          </>
        )}
        <p className="field-hint m-0 flex-1 text-right">{loop ? 'Saving restarts the count' : 'Waits while the agent is starting or needs you'}</p>
      </div>
    </details>
  )
}

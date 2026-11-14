import { GOAL_REACHED, OUTPUT_COOLDOWN_SEC, PAUSED_ON_REOPEN } from '../../shared/loop'
import type { AgentState } from '../domain/adapter'
import { AgentError } from '../domain/agent'
import { goalReached, normalizeLoop, OutputMatcher, UUID_RE, type Loop, type LoopInput, type SavedLoop } from '../domain/loop'

export type LoopEvent = { type: 'changed' } | { type: 'notice'; text: string }
export const PAUSED_BY_YOU = 'Paused by you'

/** What the engine needs from the rest of main; injected so it runs without Electron (and with fake timers). */
export type LoopPorts = {
  /** an agent of the window (never a console) */
  agent(ownerId: number, id: string): { id: string; name: string; state: AgentState } | undefined
  /** a terminal of the window (agent or console) */
  hasTerminal(ownerId: number, id: string): boolean
  /** the workspace a terminal of the window is on, when known */
  workspaceOf(ownerId: number, id: string): string | undefined
  /** the reply the agent's last turn ended with (its transcript), null when unknown */
  lastMessage(ownerId: number, id: string): Promise<string | null>
  /** through the flow engine (FlowEngine.loopPrompt): 'sent' | 'queued', else why not */
  fire(ownerId: number, agentId: string, text: string, tag: string): Promise<string>
  /** a queued prompt of this loop is taken back (FlowEngine.withdraw) */
  withdraw(agentId: string, tag: string): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  emit(ownerId: number, e: LoopEvent): void
}

/** `pending`: none, its prompt waits in the queue, or the turn it started has not ended yet. A loop never has more than one. */
type Entry = { loop: Loop; pending: 'none' | 'queued' | 'turn'; firing: boolean; timer?: unknown; matcher?: OutputMatcher; lastFire: number }

/**
 * RunLoops: one repeated prompt per agent, fired by a schedule, by the agent resting for a while or by a text in a terminal's new
 * output, always through the flow engine (same queue, kill switch and burst guard). After each turn it started: done when the reply
 * contains the goal, paused after maxRuns. `msPerSec` scales every timer (1000 in production; tests only).
 */
export class LoopEngine {
  private entries = new Map<string, Entry>() // by agent id
  constructor(
    private p: LoopPorts,
    private newId: () => string,
    private msPerSec = 1000,
  ) {}

  list(ownerId: number): Loop[] {
    return [...this.entries.values()].filter((e) => e.loop.ownerId === ownerId).map((e) => e.loop)
  }

  /** Creates or replaces the agent's loop, active from zero runs. `opts.paused`: comes back paused for that reason (reopen). */
  set(ownerId: number, agentId: string, input: LoopInput, opts: { id?: string; paused?: string } = {}): Loop {
    const a = this.p.agent(ownerId, agentId)
    if (!a || a.state === 'exited' || a.state === 'error') throw new AgentError('A loop needs a running agent')
    const workspaceId = this.p.workspaceOf(ownerId, agentId)
    if (!workspaceId) throw new AgentError('Unknown agent')
    const clean = normalizeLoop(input)
    if (clean.trigger.kind === 'output' && clean.trigger.terminalId === agentId) throw new AgentError("A loop cannot watch its own agent's terminal")
    if (clean.trigger.kind === 'output' && (!this.p.hasTerminal(ownerId, clean.trigger.terminalId) || this.p.workspaceOf(ownerId, clean.trigger.terminalId) !== workspaceId)) {
      throw new AgentError('Watch a terminal of the same workspace')
    }
    const old = this.entries.get(agentId)
    if (old) this.drop(old)
    const loop: Loop = { ...clean, id: opts.id ?? this.newId(), ownerId, workspaceId, agentId, runs: 0, state: opts.paused ? 'paused' : 'active', reason: opts.paused ?? null }
    const e: Entry = { loop, pending: 'none', firing: false, lastFire: -Infinity }
    this.entries.set(agentId, e)
    this.arm(e)
    this.changed(ownerId)
    return loop
  }

  /** A saved loop whose agent came back (ids already mapped): paused, from zero, until the user resumes it. */
  restore(ownerId: number, s: SavedLoop): Loop {
    return this.set(ownerId, s.agentId, s, { id: s.id, paused: PAUSED_ON_REOPEN })
  }

  private owned(ownerId: number, id: string): Entry {
    const e = [...this.entries.values()].find((x) => x.loop.id === id)
    if (!e || e.loop.ownerId !== ownerId) throw new AgentError('Unknown loop')
    return e
  }

  /** By the user. Resuming a loop that is done or ran out of runs starts it from zero again. */
  update(ownerId: number, id: string, paused: boolean): Loop {
    const e = this.owned(ownerId, id)
    const l = e.loop
    if (paused && l.state === 'active') {
      this.stop(e, 'paused', PAUSED_BY_YOU)
    } else if (!paused && l.state !== 'active') {
      if (l.state === 'done' || l.runs >= l.maxRuns) l.runs = 0
      ;[l.state, l.reason] = ['active', null]
      this.arm(e)
    }
    this.changed(ownerId)
    return l
  }

  remove(ownerId: number, id: string): void {
    this.drop(this.owned(ownerId, id))
    this.changed(ownerId)
  }

  /** After a card or workspace went away: loops of closed agents go, and so do loops watching a terminal that is gone. */
  prune(ownerId: number): void {
    let gone = false
    for (const e of [...this.entries.values()]) {
      const l = e.loop
      if (l.ownerId !== ownerId) continue
      const agent = this.p.agent(ownerId, l.agentId)
      const lost = l.trigger.kind === 'output' && !this.p.hasTerminal(ownerId, l.trigger.terminalId)
      if (agent && !lost) continue
      this.drop(e)
      gone = true
      if (agent) this.p.emit(ownerId, { type: 'notice', text: `Loop of ${agent.name} removed, the terminal it watched was closed` })
    }
    if (gone) this.changed(ownerId)
  }

  /** The window is gone: every timer of it stops. */
  dropOwner(ownerId: number): void {
    for (const e of [...this.entries.values()]) if (e.loop.ownerId === ownerId) this.drop(e)
  }

  /** Pause all or Resume all: time spent paused never counts toward an idle trigger (its count starts again). */
  restartIdle(ownerId: number): void {
    for (const e of this.entries.values()) if (e.loop.ownerId === ownerId && e.loop.trigger.kind === 'idle') this.arm(e)
  }

  /** Any change of the agent's state restarts its idle count; a stopped or failed agent loses its loop. */
  onState(ownerId: number, agentId: string, state: AgentState): void {
    const e = this.entries.get(agentId)
    if (!e || e.loop.ownerId !== ownerId) return
    if (state === 'exited' || state === 'error') {
      this.drop(e)
      return this.changed(ownerId)
    }
    if (e.loop.trigger.kind === 'idle') this.arm(e)
  }

  /**
   * The agent became idle. After a Stop that ends the turn the loop started: one more run, then the goal (read before anything
   * else can fire: the loop stays pending meanwhile) and maxRuns. Idle without a Stop (interrupted, failed: rate limit, network,
   * Esc): the run still counts toward maxRuns, only the goal is not read, so a failing turn can never repeat without end.
   */
  async onIdle(ownerId: number, agentId: string, byStop: boolean): Promise<void> {
    const e = this.entries.get(agentId)
    if (!e || e.loop.ownerId !== ownerId || e.pending !== 'turn') return
    const l = e.loop
    const message = byStop && l.goal ? await this.p.lastMessage(ownerId, agentId).catch(() => null) : null
    if (this.entries.get(agentId) !== e) return // removed or replaced meanwhile
    e.pending = 'none'
    l.runs++
    const name = this.p.agent(ownerId, agentId)?.name ?? 'an agent'
    if (message !== null && goalReached(message, l.goal)) {
      this.stop(e, 'done', GOAL_REACHED)
      this.p.emit(ownerId, { type: 'notice', text: `Loop of ${name} done, ${GOAL_REACHED.toLowerCase()} after ${l.runs} run${l.runs === 1 ? '' : 's'}` })
    } else if (l.runs >= l.maxRuns && l.state === 'active') {
      const why = `Stopped after ${l.runs} run${l.runs === 1 ? '' : 's'}`
      this.stop(e, 'paused', why)
      this.p.emit(ownerId, { type: 'notice', text: `Loop of ${name} paused, ${why.toLowerCase()}` })
    }
    this.changed(ownerId)
  }

  /** What the flow engine's queue did with a loop's prompt (its tag is the loop id). */
  track(agentId: string, tags: string[], ev: 'queued' | 'delivered' | 'returned' | 'dropped'): void {
    const e = this.entries.get(agentId)
    if (!e || !tags.includes(e.loop.id)) return
    e.pending = ev === 'delivered' ? 'turn' : ev === 'dropped' ? 'none' : 'queued'
  }

  /** New output of a terminal: loops watching it for their text fire, at most once per cooldown. */
  onOutput(ownerId: number, terminalId: string, data: string): void {
    for (const e of this.entries.values()) {
      const t = e.loop.trigger
      if (e.loop.ownerId !== ownerId || t.kind !== 'output' || t.terminalId !== terminalId || !e.matcher) continue
      if (e.matcher.feed(data) && this.p.now() - e.lastFire >= OUTPUT_COOLDOWN_SEC * this.msPerSec) void this.fire(e)
    }
  }

  /** Starts (again) what makes an active loop fire: its schedule, its idle count (only while the agent is idle) or its watcher. */
  private arm(e: Entry): void {
    this.disarm(e)
    const l = e.loop
    if (l.state !== 'active') return
    const t = l.trigger
    if (t.kind === 'output') e.matcher = new OutputMatcher(t.text)
    else if (t.kind === 'schedule' || this.p.agent(l.ownerId, l.agentId)?.state === 'idle') this.tick(e, (t.kind === 'schedule' ? t.everySec : t.afterSec) * this.msPerSec)
  }

  /** Fires every `ms` while it stays armed (an idle count that could not fire, e.g. while paused, tries again a full count later). */
  private tick(e: Entry, ms: number): void {
    e.timer = this.p.setTimer(() => {
      if (this.entries.get(e.loop.agentId) !== e) return
      this.tick(e, ms)
      void this.fire(e)
    }, ms)
  }

  private disarm(e: Entry): void {
    if (e.timer !== undefined) this.p.clearTimer(e.timer)
    e.timer = undefined
    e.matcher = undefined
  }

  /** One firing, unless the loop is not active or its previous prompt is still waiting or running (never two in the queue). */
  private async fire(e: Entry): Promise<void> {
    const l = e.loop
    if (l.state !== 'active' || e.pending !== 'none' || e.firing || this.entries.get(l.agentId) !== e) return
    e.firing = true
    try {
      const r = await this.p.fire(l.ownerId, l.agentId, l.prompt, l.id)
      if (r === 'sent' || r === 'queued') e.lastFire = this.p.now()
    } finally {
      e.firing = false
    }
  }

  private stop(e: Entry, state: 'paused' | 'done', reason: string): void {
    ;[e.loop.state, e.loop.reason] = [state, reason]
    this.disarm(e)
    if (e.pending === 'queued') e.pending = 'none'
    this.p.withdraw(e.loop.agentId, e.loop.id)
  }

  private drop(e: Entry): void {
    this.disarm(e)
    this.p.withdraw(e.loop.agentId, e.loop.id)
    if (this.entries.get(e.loop.agentId) === e) this.entries.delete(e.loop.agentId)
  }

  private changed(ownerId: number): void {
    this.p.emit(ownerId, { type: 'changed' })
  }
}

/**
 * Saved loops whose agent came back (`ids`: saved id -> new id), with their ids mapped; a loop watching a terminal that did not come
 * back goes too, and so does one whose own id is not a UUID.
 */
export function remapLoops(saved: SavedLoop[], ids: ReadonlyMap<string, string>): SavedLoop[] {
  return saved.flatMap((s) => {
    const agentId = ids.get(s.agentId)
    if (!agentId || !UUID_RE.test(s.id)) return [] // read back from the database: never trusted
    if (s.trigger.kind !== 'output') return [{ ...s, agentId }]
    const terminalId = ids.get(s.trigger.terminalId)
    return terminalId ? [{ ...s, agentId, trigger: { ...s.trigger, terminalId } }] : []
  })
}

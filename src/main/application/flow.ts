import { PROMPT_MAX } from '../../shared/agent'
import { DEFAULT_TEMPLATE, EDGES_MAX } from '../../shared/flow'
import { AgentError, HeldInput } from '../domain/agent'
import { BURST_MAX, BURST_WINDOW_MS, LOOP_FIRES, MAX_HOPS, matchesCondition, renderTemplate, sameEndpoint, type Edge, type SourceEndpoint, type TargetEndpoint } from '../domain/edge'

export type FlowEvent = { type: 'changed' } | { type: 'fired'; id: string } | { type: 'paused'; id: string | null; reason: string }
export type AgentView = { id: string; name: string; role: string; workspaceId?: string }

/** What the engine needs from the rest of main; injected so it runs without Electron. */
export type FlowPorts = {
  agent(ownerId: number, id: string): AgentView | undefined
  group(ownerId: number, id: string): { id: string; name: string; memberIds: string[] } | undefined
  groupOf(agentId: string): { id: string; name: string } | undefined
  squad(ownerId: number, id: string): { orchestratorId: string } | undefined
  lastMessage(ownerId: number, id: string): Promise<string | null>
  /** idle: may be written to now; busy (working or needing the user): queue it; refused: why not (completes "<name> ...", e.g. "is still starting", "is paused") */
  readiness(ownerId: number, id: string): 'idle' | 'busy' | { refused: string }
  /**
   * bracketed paste + Enter, re-checking that the agent is still idle and nothing is paused before the paste and before the Enter;
   * throws an AgentError completing "<name> ...", a HeldInput when the text was pasted but the Enter withheld
   */
  deliver(ownerId: number, id: string, text: string): Promise<void>
  now(): number
  emit(ownerId: number, e: FlowEvent): void
  /** what the queue did with tagged messages (tasks) for that agent; 'delivered' comes right before the paste */
  track?(agentId: string, tags: string[], e: 'queued' | 'delivered' | 'returned' | 'dropped'): void
}

/** One chain of turns started by a user prompt: how often each edge fired in it. */
type Chain = { fired: Map<string, number> }
/** The chain an agent's current (or next) turn belongs to, set when a flow or a message injects into it. */
type Mark = { ownerId: number; chain: Chain; hop: number }
const BURST = Symbol('burst')
/** A message waiting for its agent to be idle, with the chain it continues and the task it carries, if any. */
type Pending = { text: string; mark: Mark; tag?: string }
export const INBOX_MAX = 10
export const INBOX_CHARS = 4 * PROMPT_MAX
const SEP = '\n\n'

/** Several messages joined into one prompt continue all their chains: the highest hop and the sum of every edge's firings. */
export function mergeMarks(ms: Mark[]): Mark {
  if (ms.length === 1) return ms[0]!
  const fired = new Map<string, number>()
  for (const m of ms) for (const [k, v] of m.chain.fired) fired.set(k, (fired.get(k) ?? 0) + v)
  return { ownerId: ms[0]!.ownerId, chain: { fired }, hop: Math.max(...ms.map((m) => m.hop)) }
}

export const PAUSED_BY_USER = 'Paused by you'

/**
 * RunFlow: edges in memory (persistence is F8). On a Stop, the agent's last message goes through every active edge leaving it
 * (or its group) into the target, under the guards: MAX_HOPS per chain, LOOP_FIRES of one edge per chain pauses that edge,
 * more than BURST_MAX injections in BURST_WINDOW_MS pauses every flow of the window, and a global kill switch (Pause all).
 */
export class FlowEngine {
  private edges = new Map<string, Edge>()
  private paused = new Set<number>() // owners whose flows are paused
  private marks = new Map<string, Mark>()
  private recent = new Map<number, number[]>() // owner -> injection times
  private inbox = new Map<string, { ownerId: number; items: Pending[] }>() // agent -> messages waiting for it to be idle
  private draining = new Set<string>()
  private muted = new Map<string, number>() // agent -> owner: agents whose running turn must not pass its reply on (a handoff's briefing)
  constructor(
    private p: FlowPorts,
    private newId: () => string,
  ) {}

  list(ownerId: number): Edge[] {
    return [...this.edges.values()].filter((e) => e.ownerId === ownerId)
  }

  flowsPaused(ownerId: number): boolean {
    return this.paused.has(ownerId)
  }

  /** The agents an endpoint stands for, all in one workspace; null when it is gone or not connectable (e.g. a group of consoles). */
  resolve(ownerId: number, ep: SourceEndpoint | TargetEndpoint): { workspaceId: string; agents: AgentView[] } | null {
    const ids = ep.kind === 'agent' ? [ep.id] : ep.kind === 'squad' ? [this.p.squad(ownerId, ep.id)?.orchestratorId ?? ''] : (this.p.group(ownerId, ep.id)?.memberIds ?? [])
    const agents = ids.flatMap((id) => this.p.agent(ownerId, id) ?? [])
    const ws = new Set(agents.map((a) => a.workspaceId))
    const [only] = ws
    return agents.length > 0 && ws.size === 1 && only ? { workspaceId: only, agents } : null
  }

  /** `id` and `paused`: a saved edge coming back as it was. */
  create(ownerId: number, source: SourceEndpoint, target: TargetEndpoint, opts: { template?: string; condition?: string; id?: string; paused?: string | null } = {}): Edge {
    const s = this.resolve(ownerId, source)
    const t = this.resolve(ownerId, target)
    if (!s || !t) throw new AgentError('Unknown card')
    if (sameEndpoint(source, target) || (source.kind === 'agent' && t.agents.every((a) => a.id === source.id))) throw new AgentError('An agent cannot connect to itself')
    if (s.workspaceId !== t.workspaceId) throw new AgentError('Both ends must be in the same workspace')
    const mine = this.list(ownerId)
    if (mine.some((e) => sameEndpoint(e.source, source) && sameEndpoint(e.target, target))) throw new AgentError('These are already connected')
    if (mine.length >= EDGES_MAX) throw new AgentError(`Edge limit reached (${EDGES_MAX})`)
    if (opts.id !== undefined && this.edges.has(opts.id)) throw new AgentError('Duplicate edge')
    const e: Edge = { id: opts.id ?? this.newId(), ownerId, workspaceId: s.workspaceId, source, target, template: opts.template ?? DEFAULT_TEMPLATE, condition: opts.condition ?? '', paused: opts.paused ?? null, note: null }
    this.edges.set(e.id, e)
    this.changed(ownerId)
    return e
  }

  private owned(ownerId: number, id: string): Edge {
    const e = this.edges.get(id)
    if (!e || e.ownerId !== ownerId) throw new AgentError('Unknown edge')
    return e
  }

  /** `paused: false` resumes an edge a guard or the user paused. */
  update(ownerId: number, id: string, patch: { template?: string; condition?: string; paused?: boolean }): Edge {
    const e = this.owned(ownerId, id)
    if (patch.template !== undefined) e.template = patch.template
    if (patch.condition !== undefined) e.condition = patch.condition
    if (patch.paused === true && !e.paused) e.paused = PAUSED_BY_USER
    if (patch.paused === false) [e.paused, e.note] = [null, null]
    this.changed(ownerId)
    return e
  }

  remove(ownerId: number, id: string): void {
    this.owned(ownerId, id)
    this.edges.delete(id)
    this.changed(ownerId)
  }

  /** After a card, group, squad or workspace went away: drops the edges that lost an end (and the chain marks of closed agents). */
  prune(ownerId: number): void {
    let gone = false
    for (const e of this.list(ownerId)) {
      if (this.resolve(ownerId, e.source) && this.resolve(ownerId, e.target)) continue
      this.edges.delete(e.id)
      gone = true
    }
    for (const [id, m] of this.marks) if (m.ownerId === ownerId && !this.p.agent(ownerId, id)) this.marks.delete(id)
    for (const [id, b] of this.inbox) if (b.ownerId === ownerId && !this.p.agent(ownerId, id)) this.inbox.delete(id) // its queue goes with a closed agent
    for (const [id, o] of this.muted) if (o === ownerId && !this.p.agent(ownerId, id)) this.muted.delete(id)
    if (gone) this.changed(ownerId)
  }

  /** The window is gone. */
  dropOwner(ownerId: number): void {
    for (const e of this.list(ownerId)) this.edges.delete(e.id)
    for (const [id, m] of this.marks) if (m.ownerId === ownerId) this.marks.delete(id)
    for (const [id, b] of this.inbox) if (b.ownerId === ownerId) this.inbox.delete(id)
    for (const [id, o] of this.muted) if (o === ownerId) this.muted.delete(id)
    this.paused.delete(ownerId)
    this.recent.delete(ownerId)
  }

  /** Kill switch: nothing is injected until resumeAll. */
  pauseAll(ownerId: number): void {
    this.paused.add(ownerId)
    this.changed(ownerId)
  }

  /** Also delivers what was held for agents that are idle now. */
  resumeAll(ownerId: number): void {
    this.paused.delete(ownerId)
    this.recent.delete(ownerId)
    this.changed(ownerId)
    for (const [id, b] of this.inbox) if (b.ownerId === ownerId) void this.drain(ownerId, id)
  }

  /** Messages waiting for that agent (tests and diagnostics). */
  queued(agentId: string): number {
    return this.inbox.get(agentId)?.items.length ?? 0
  }

  /**
   * The agent became idle: a finished turn (Stop) first passes its reply on, then whatever waited for it is delivered. A muted
   * turn passes nothing on; any end of the turn (with or without a Stop) lifts the mute.
   */
  async onIdle(ownerId: number, agentId: string, byStop: boolean): Promise<void> {
    const muted = this.muted.delete(agentId)
    if (byStop && muted) this.marks.delete(agentId)
    else if (byStop) await this.onStop(ownerId, agentId)
    await this.drain(ownerId, agentId)
  }

  /** The agent's next turn (a handoff's briefing) never fires an edge: its reply only goes where the user sends it. */
  muteNextStop(ownerId: number, agentId: string): void {
    this.muted.set(agentId, ownerId)
  }

  /** The muted turn never started (its prompt was refused, or never submitted): nothing to keep muted. */
  unmute(agentId: string): void {
    this.muted.delete(agentId)
  }

  /** Something waits for the agent or is being written to it right now. */
  pending(agentId: string): boolean {
    return this.queued(agentId) > 0 || this.draining.has(agentId)
  }

  /** The user prompted the agent: its next turn starts a new chain (the only way one starts besides a turn no flow or message caused). */
  userPrompt(agentId: string): void {
    this.marks.delete(agentId)
  }

  /** The agent's turn ended: its last message goes through each active edge leaving it or its group. */
  async onStop(ownerId: number, agentId: string): Promise<void> {
    const from = this.marks.get(agentId) ?? { ownerId, chain: { fired: new Map() }, hop: 0 }
    this.marks.delete(agentId)
    const src = this.p.agent(ownerId, agentId)
    if (!src || this.paused.has(ownerId)) return
    const group = this.p.groupOf(agentId)
    const out = this.list(ownerId).filter((e) => !e.paused && (e.source.kind === 'agent' ? e.source.id === agentId : e.source.id === group?.id))
    if (out.length === 0) return
    const message = await this.p.lastMessage(ownerId, agentId).catch(() => null)
    for (const e of out) await this.fire(e, from, { ...src, group: group?.name ?? '' }, message)
  }

  private async fire(e: Edge, from: Mark, src: AgentView & { group: string }, message: string | null): Promise<void> {
    const { ownerId } = e
    if (this.edges.get(e.id) !== e || e.paused || this.paused.has(ownerId)) return // removed or paused meanwhile
    if (message === null) return this.setNote(e, `${src.name} had no message to pass on`)
    if (!matchesCondition(message, e.condition)) return
    const hop = from.hop + 1
    if (hop > MAX_HOPS) return this.autoPause(e, `Stopped after ${MAX_HOPS} hops in one chain`)
    const times = (from.chain.fired.get(e.id) ?? 0) + 1
    if (times >= LOOP_FIRES) return this.autoPause(e, `Loop detected, this edge fired ${LOOP_FIRES} times in one chain`)
    from.chain.fired.set(e.id, times)
    const text = renderTemplate(e.template, { message, name: src.name, role: src.role, group: src.group })
    const targets = this.resolve(ownerId, e.target)?.agents.filter((a) => a.id !== src.id) ?? []
    const skipped: string[] = []
    let reached = 0
    for (const t of targets) {
      const r = await this.inject(ownerId, t, text, { ownerId, chain: from.chain, hop })
      if (r === BURST) return
      if (r === 'sent' || r === 'queued') reached++
      else skipped.push(r)
    }
    if (reached > 0) this.p.emit(ownerId, { type: 'fired', id: e.id })
    this.setNote(e, skipped.length ? `Not delivered, ${skipped.join('; ')}` : null)
  }

  /**
   * Written now when the agent is idle, else queued until it is (never typed into a working agent, nor into one that may show a
   * permission dialog, where an Enter would answer for the user). 'sent' | 'queued', else why not; BURST when the burst guard just
   * paused everything.
   */
  private async inject(ownerId: number, t: AgentView, text: string, mark: Mark, tag?: string): Promise<'sent' | 'queued' | string | typeof BURST> {
    const ready = this.p.readiness(ownerId, t.id)
    if (typeof ready === 'object') return `${t.name} ${ready.refused}`
    const box = this.inbox.get(t.id) ?? { ownerId, items: [] }
    if (box.items.length >= INBOX_MAX || box.items.reduce((n, i) => n + i.text.length, text.length) > INBOX_CHARS) return `${t.name} has too many messages waiting`
    if (this.tripBurst(ownerId)) return BURST
    this.recent.get(ownerId)?.push(this.p.now())
    const item: Pending = { text, mark, tag }
    box.items.push(item)
    this.inbox.set(t.id, box)
    if (tag) this.p.track?.(t.id, [tag], 'queued')
    if (ready === 'busy') return 'queued'
    const why = await this.drain(ownerId, t.id)
    if (this.inbox.get(t.id)?.items.includes(item)) return 'queued' // held (paused, another delivery under way) or put back for the next idle
    return why === null ? 'sent' : `${t.name} ${why}`
  }

  /**
   * Delivers what waits for an idle agent as ONE prompt (as many messages as fit in PROMPT_MAX; the rest waits for the next idle).
   * Held while anything is paused. The prompt's turn continues the merged chain. Returns null when delivered, else why not.
   */
  private async drain(ownerId: number, id: string): Promise<string | null> {
    const box = this.inbox.get(id)
    if (!box || box.items.length === 0 || this.draining.has(id) || this.paused.has(ownerId)) return null
    if (this.p.readiness(ownerId, id) !== 'idle') return null
    let take = 0
    let len = 0
    for (const it of box.items) {
      const add = it.text.length + (take ? SEP.length : 0)
      if (take > 0 && len + add > PROMPT_MAX) break
      len += add
      take++
    }
    const batch = box.items.splice(0, take)
    const before = this.marks.get(id)
    const mark = mergeMarks([...(before ? [before] : []), ...batch.map((b) => b.mark)])
    this.marks.set(id, mark) // before the Enter: its Stop must find the chain, and the mark lasts until that Stop
    const tags = batch.flatMap((b) => (b.tag ? [b.tag] : []))
    if (tags.length) this.p.track?.(id, tags, 'delivered') // before the Enter too: its Stop must find the task running
    this.draining.add(id)
    try {
      await this.p.deliver(ownerId, id, batch.map((b) => b.text).join(SEP))
      return null
    } catch (err) {
      if (this.marks.get(id) === mark) {
        if (before) this.marks.set(id, before)
        else this.marks.delete(id)
      }
      // pasted but not submitted: the text is in its input for the user to see, never sent twice; else it waits for the next idle
      if (!(err instanceof HeldInput)) box.items.unshift(...batch)
      if (tags.length) this.p.track?.(id, tags, err instanceof HeldInput ? 'dropped' : 'returned')
      return err instanceof AgentError ? err.message : 'could not be reached'
    } finally {
      this.draining.delete(id)
      if (box.items.length === 0 && this.inbox.get(id) === box) this.inbox.delete(id)
    }
  }

  /** One more automatic action (a spawn request) under the kill switch and the burst guard; throws when flows are paused or it trips. */
  charge(ownerId: number): void {
    if (this.paused.has(ownerId)) throw new AgentError('Flows are paused')
    if (this.tripBurst(ownerId)) throw new AgentError('Too many messages, all flows paused')
    this.recent.get(ownerId)?.push(this.p.now())
  }

  /**
   * A message for an agent that is still starting (spawn_agent's task): queued whatever its state and delivered, like any other,
   * on its first idle (never while starting: an Enter could answer the trust dialog). Continues `fromId`'s chain; counts toward the
   * burst guard (throws, nothing queued, when flows are paused or it trips).
   */
  hold(ownerId: number, fromId: string, to: AgentView, text: string, tag?: string): void {
    const own = this.marks.get(fromId)
    this.charge(ownerId)
    const box = this.inbox.get(to.id) ?? { ownerId, items: [] }
    box.items.push({ text, mark: { ownerId, chain: own?.chain ?? { fired: new Map() }, hop: (own?.hop ?? 0) + 1 }, tag })
    this.inbox.set(to.id, box)
    if (tag) this.p.track?.(to.id, [tag], 'queued')
    void this.drain(ownerId, to.id)
  }

  /**
   * A loop's prompt for one of its agents: it starts a new chain and goes through the same queue, kill switch and burst guard as any
   * injection (written only while the agent is idle, held while anything is paused). Returns 'sent' | 'queued', else why not.
   */
  async loopPrompt(ownerId: number, agentId: string, text: string, tag: string): Promise<string> {
    if (this.paused.has(ownerId)) return 'flows are paused'
    const t = this.p.agent(ownerId, agentId)
    if (!t) return 'is not running'
    const r = await this.inject(ownerId, t, text, { ownerId, chain: { fired: new Map() }, hop: 0 }, tag)
    return r === BURST ? 'too many messages, all flows paused' : r
  }

  /** Takes back what still waits in the agent's queue under that tag (a loop paused or removed); never what is being delivered. */
  withdraw(agentId: string, tag: string): void {
    const box = this.inbox.get(agentId)
    if (!box) return
    for (let i = box.items.length - 1; i >= 0; i--) if (box.items[i]!.tag === tag) box.items.splice(i, 1)
    if (box.items.length === 0 && !this.draining.has(agentId)) this.inbox.delete(agentId)
  }

  /** True (and every flow paused, with the reason) when this injection would be one too many. */
  private tripBurst(ownerId: number): boolean {
    const now = this.p.now()
    const recent = (this.recent.get(ownerId) ?? []).filter((t) => now - t < BURST_WINDOW_MS)
    this.recent.set(ownerId, recent)
    if (recent.length < BURST_MAX) return false
    this.paused.add(ownerId)
    this.p.emit(ownerId, { type: 'paused', id: null, reason: `More than ${BURST_MAX} messages in ${BURST_WINDOW_MS / 1000} s, all flows paused` })
    this.changed(ownerId)
    return true
  }

  /**
   * send_message: same kill switch, burst guard and queue as the flows; the recipient's turn continues the sender's chain (one hop more).
   * Returns who got it, who will get it once idle, and who did not (with why).
   */
  async send(ownerId: number, fromId: string, targets: AgentView[], text: string, tag?: string): Promise<{ sent: string[]; queued: string[]; skipped: string[] }> {
    if (this.paused.has(ownerId)) throw new AgentError('Flows are paused')
    const own = this.marks.get(fromId)
    const mark: Mark = { ownerId, chain: own?.chain ?? { fired: new Map() }, hop: (own?.hop ?? 0) + 1 }
    if (mark.hop > MAX_HOPS) throw new AgentError(`Chain limit reached (${MAX_HOPS} hops)`)
    const sent: string[] = []
    const queued: string[] = []
    const skipped: string[] = []
    for (const t of targets) {
      const r = await this.inject(ownerId, t, text, mark, tag)
      if (r === BURST) throw new AgentError('Too many messages, all flows paused')
      if (r === 'sent') sent.push(t.name)
      else if (r === 'queued') queued.push(t.name)
      else skipped.push(r)
    }
    return { sent, queued, skipped }
  }

  private autoPause(e: Edge, reason: string): void {
    e.paused = reason
    this.p.emit(e.ownerId, { type: 'paused', id: e.id, reason })
    this.changed(e.ownerId)
  }

  private setNote(e: Edge, note: string | null): void {
    if (e.note === note) return
    e.note = note
    this.changed(e.ownerId)
  }

  private changed(ownerId: number): void {
    this.p.emit(ownerId, { type: 'changed' })
  }
}

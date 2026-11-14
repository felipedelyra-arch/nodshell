import type { HANDOFF_STATES } from '../../shared/handoff'
import type { AgentState } from '../domain/adapter'
import { AgentError } from '../domain/agent'
import { BRIEFING_REQUEST, briefingOf, handoffPrompt, SUMMARY_TIMEOUT_MS } from '../domain/handoff'

export type HandoffState = (typeof HANDOFF_STATES)[number]
/** `briefing`: '' while summarizing; the outgoing agent's reply (cleaned, capped) once ready. */
export type Handoff = { id: string; ownerId: number; workspaceId: string; fromId: string; toId: string; state: HandoffState; briefing: string }
/** `notice`: a handoff ended by itself (no summary, timeout, an agent closed); shown to the user. */
export type HandoffEvent = { type: 'changed'; notice?: string }
type Peer = { id: string; name: string; role: string; branch: string; state: AgentState; workspaceId?: string }

/** What the service needs from the rest of main; injected so it runs without Electron (and with fake timers). */
export type HandoffPorts = {
  /** an agent of the window (never a console) */
  agent(ownerId: number, id: string): Peer | undefined
  /**
   * the user's prompt (bracketed paste + Enter), written only while the agent rests (checked before the paste and before the Enter),
   * with its next Stop muted for the flows (the briefing never fires an edge); throws an AgentError when refused
   */
  ask(ownerId: number, id: string, text: string): Promise<void>
  /** something waits in the flow engine's queue for the agent, or is being written to it */
  pending(ownerId: number, id: string): boolean
  /** a handoff ended before its briefing turn did: lift the flows' mute unless that turn is running */
  release(ownerId: number, id: string): void
  /** the reply the agent's last turn ended with (its transcript), null when unknown */
  lastMessage(ownerId: number, id: string): Promise<string | null>
  /** through the flow engine's queue (FlowEngine.loopPrompt): 'sent' | 'queued', else why not */
  deliver(ownerId: number, agentId: string, text: string, tag: string): Promise<string>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  emit(ownerId: number, e: HandoffEvent): void
}

type Entry = Handoff & { timer?: unknown; busy: boolean }
const gone = (s: AgentState) => s === 'exited' || s === 'error'
const view = ({ id, ownerId, workspaceId, fromId, toId, state, briefing }: Entry): Handoff => ({ id, ownerId, workspaceId, fromId, toId, state, briefing })

/**
 * Handoff: the outgoing agent writes its own briefing (a fixed prompt, answered on its next Stop), the user edits it in a dialog,
 * and only Send delivers it to the next agent as ONE prompt through the flow engine's queue. At most one per outgoing agent;
 * nothing is persisted. A turn that ends without a Stop, an empty reply, a closed agent or no reply in time cancels it, with a notice.
 */
export class HandoffService {
  private items = new Map<string, Entry>()
  constructor(
    private p: HandoffPorts,
    private newId: () => string,
    private timeoutMs = SUMMARY_TIMEOUT_MS,
  ) {}

  list(ownerId: number): Handoff[] {
    return [...this.items.values()].filter((h) => h.ownerId === ownerId).map(view)
  }

  /** Asks `fromId` (resting) for its briefing, for `toId` in the same workspace. */
  async start(ownerId: number, fromId: string, toId: string): Promise<Handoff> {
    const from = this.p.agent(ownerId, fromId)
    const to = this.p.agent(ownerId, toId)
    if (!from || !to) throw new AgentError('Unknown agent')
    if (fromId === toId) throw new AgentError('An agent cannot hand off to itself')
    if (!from.workspaceId || from.workspaceId !== to.workspaceId) throw new AgentError('Both agents must be in the same workspace')
    if ([...this.items.values()].some((h) => h.fromId === fromId)) throw new AgentError(`${from.name} already has a handoff in progress`)
    if (from.state !== 'idle') throw new AgentError(`${from.name} must be resting to write its summary`)
    if (gone(to.state)) throw new AgentError(`${to.name} is not running`)
    // a delivery right after the request would end the turn read as the briefing
    if (this.p.pending(ownerId, fromId)) throw new AgentError(`${from.name} has messages waiting, try again`)
    const h: Entry = { id: this.newId(), ownerId, workspaceId: from.workspaceId, fromId, toId, state: 'summarizing', briefing: '', busy: false }
    // in place before the prompt goes in: its Stop must find it, and a second start for the same agent is refused
    this.items.set(h.id, h)
    h.timer = this.p.setTimer(() => this.end(h, `Handoff from ${from.name} cancelled, no summary in ${Math.round(this.timeoutMs / 60_000)} minutes`), this.timeoutMs)
    try {
      await this.p.ask(ownerId, fromId, BRIEFING_REQUEST)
    } catch (e) {
      this.end(h)
      throw e
    }
    if (this.items.get(h.id) !== h) throw new AgentError('The handoff was cancelled')
    this.changed(ownerId)
    return view(h)
  }

  /** The outgoing agent became idle: after its Stop its last reply is the briefing; idle without a Stop (failed, Esc) cancels. */
  async onIdle(ownerId: number, agentId: string, byStop: boolean): Promise<void> {
    const h = [...this.items.values()].find((x) => x.ownerId === ownerId && x.fromId === agentId && x.state === 'summarizing' && !x.busy)
    if (!h) return
    const name = this.p.agent(ownerId, agentId)?.name ?? 'an agent'
    if (!byStop) return this.end(h, `Handoff from ${name} cancelled, its turn ended without a summary`)
    h.busy = true
    this.clear(h)
    const message = await this.p.lastMessage(ownerId, agentId).catch(() => null)
    if (this.items.get(h.id) !== h) return // cancelled meanwhile
    h.busy = false
    const briefing = message === null ? '' : briefingOf(message)
    if (!briefing) return this.end(h, `Handoff from ${name} cancelled, ${name} wrote no summary`)
    ;[h.state, h.briefing] = ['ready', briefing]
    this.changed(ownerId)
  }

  /** A stopped or failed agent ends every handoff it is part of. */
  onState(ownerId: number, agentId: string, state: AgentState): void {
    if (!gone(state)) return
    for (const h of [...this.items.values()]) {
      if (h.ownerId !== ownerId || (h.fromId !== agentId && h.toId !== agentId)) continue
      this.end(h, `Handoff ${this.names(h)} cancelled, ${this.p.agent(ownerId, agentId)?.name ?? 'an agent'} stopped`)
    }
  }

  /** After a card or workspace went away: handoffs that lost an agent go, with a notice. */
  prune(ownerId: number): void {
    for (const h of [...this.items.values()]) {
      if (h.ownerId !== ownerId || (this.p.agent(ownerId, h.fromId) && this.p.agent(ownerId, h.toId))) continue
      this.end(h, `Handoff ${this.names(h)} cancelled, an agent was closed`)
    }
  }

  /** The window is gone (or its page reloaded, or the project changes): everything of it goes, silently, with its timers. */
  dropOwner(ownerId: number): void {
    for (const h of [...this.items.values()]) if (h.ownerId === ownerId) this.drop(h)
  }

  /**
   * Send: the (edited) briefing goes to the next agent as one prompt, through the flow engine (written only while it rests, queued
   * while busy, refused while starting or paused). Delivered or queued: the handoff is done. Refused: it stays, to try again or cancel.
   */
  async send(ownerId: number, id: string, text: string): Promise<string> {
    const h = this.owned(ownerId, id)
    if (h.state !== 'ready') throw new AgentError('The summary is not ready yet')
    if (h.busy) throw new AgentError('The handoff is already being sent')
    const from = this.p.agent(ownerId, h.fromId)
    const to = this.p.agent(ownerId, h.toId)
    if (!from || !to) throw new AgentError('Unknown agent')
    const prompt = handoffPrompt(from, text)
    h.busy = true
    let r: string
    try {
      r = await this.p.deliver(ownerId, to.id, prompt, h.id)
    } finally {
      h.busy = false
    }
    if (r !== 'sent' && r !== 'queued') throw new AgentError(`Not delivered, ${r}`)
    this.end(h)
    return r === 'sent' ? `Handoff sent to ${to.name}` : `Handoff queued for ${to.name}, delivered when its turn ends`
  }

  /** By the user: nothing is delivered. */
  cancel(ownerId: number, id: string): void {
    const h = this.owned(ownerId, id)
    if (h.busy && h.state === 'ready') throw new AgentError('The handoff is being sent')
    this.end(h)
  }

  private owned(ownerId: number, id: string): Entry {
    const h = this.items.get(id)
    if (!h || h.ownerId !== ownerId) throw new AgentError('Unknown handoff')
    return h
  }

  private names(h: Handoff): string {
    const n = (id: string) => this.p.agent(h.ownerId, id)?.name
    const from = n(h.fromId)
    const to = n(h.toId)
    return from && to ? `${from} → ${to}` : from ? `from ${from}` : to ? `to ${to}` : ''
  }

  private clear(h: Entry): void {
    if (h.timer !== undefined) this.p.clearTimer(h.timer)
    h.timer = undefined
  }

  private drop(h: Entry): void {
    this.clear(h)
    if (this.items.get(h.id) === h) this.items.delete(h.id)
  }

  /** Gone for good (and the window told, with a notice when it ended by itself). */
  private end(h: Entry, notice?: string): void {
    if (this.items.get(h.id) !== h) return
    this.drop(h)
    if (h.state === 'summarizing') this.p.release(h.ownerId, h.fromId)
    this.p.emit(h.ownerId, notice ? { type: 'changed', notice: notice.replace(/ {2,}/g, ' ') } : { type: 'changed' })
  }

  private changed(ownerId: number): void {
    this.p.emit(ownerId, { type: 'changed' })
  }
}

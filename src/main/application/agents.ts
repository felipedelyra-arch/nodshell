import { randomUUID } from 'node:crypto'
import type { AgentAdapter, AgentSignal, AgentState, HookSignal, PromptPty, SubmitGuard } from '../domain/adapter'
import { AgentError, isValidRole, needsCloseConfirm, pickAgentName, type Agent, type ConfirmDiscard, type RemovalOutcome, type Repo, type Worktree } from '../domain/agent'

/** Ports the use cases need; infrastructure implements them (WorktreeService, PtyManager, HookService). */
export type Ports = {
  adapter: AgentAdapter
  worktrees: {
    /** must return a worktree whose path already passed cwd validation */
    add(repo: Repo, role: string): Promise<Worktree>
    remove(wt: Worktree, confirm?: ConfirmDiscard): Promise<RemovalOutcome>
  }
  ptys: {
    spawnCommand(ownerId: number, cols: number, rows: number, c: { file: string; args: string[]; env: Record<string, string>; cwd: string }): string
    handle(ownerId: number, id: string): PromptPty
    kill(ownerId: number, id: string): Promise<void>
    /** cleaned last lines of the PTY output, '' when unknown */
    recentText(ownerId: number, id: string): string
  }
  /** per-agent status channel: events reach `onEvent` until `close()` */
  hooks: {
    open(sessionId: string, onEvent: (s: HookSignal) => void): { settingsPath: string; env: Record<string, string>; close(): void }
  }
  /** per-agent MCP bridge: a config file for the CLI whose token names `agentId()` until `close()` */
  mcp?: {
    open(sessionId: string, agentId: () => string | undefined): { configPath: string; close(): void }
  }
  /** called on every change of the state or of the status-unavailable flag */
  onState?: (ownerId: number, id: string, state: AgentState, statusUnavailable: boolean) => void
  /** the agent became idle; `byStop`: its own Stop hook ended a turn (flows start there) */
  onIdle?: (ownerId: number, id: string, byStop: boolean) => void
  /** the CLI reported a submitted prompt (UserPromptSubmit), typed or injected */
  onPromptSubmit?: (ownerId: number, id: string) => void
  /** the CLI started another session (e.g. /clear): the id to resume changed */
  onSession?: (ownerId: number, id: string) => void
}

/** `workspaceId`: the renderer's board the agent belongs to; agents only reach each other inside one. */
export type SpawnRequest = { role: string; model?: string; systemPrompt?: string; cols: number; rows: number; workspaceId?: string; presetId?: string }
/** Relaunch of a saved agent in its own (already revalidated) worktree, under its name; `resume`: continue its CLI session. */
export type RestoreRequest = SpawnRequest & { name: string; worktree: Worktree; sessionId: string; resume: boolean }
export type SpawnedAgent = { id: string; name: string; role: string; branch: string; model: string; state: AgentState; statusUnavailable: boolean }

/** Without any hook event this long after spawn, live status is declared unavailable. */
export const STATUS_TIMEOUT_MS = 20_000
export type LastMessage = { text: string | null; source: 'transcript' | 'scrape' | 'none' }

/** Use cases SpawnAgent, SubmitPrompt, CloseAgent and ReadLastMessage over an in-memory registry (persistence arrives in F8). */
export class AgentService {
  private agents = new Map<string, Agent>()
  private hookClosers = new Map<string, () => void>()
  private statusTimers = new Map<string, NodeJS.Timeout>()
  private pending = new Set<{ ownerId: number; name: string }>() // names of spawns still in flight
  private heard = new Set<string>() // agents that sent at least one hook event
  private closing = new Set<Promise<RemovalOutcome | 'stopped'>>()
  constructor(
    private p: Ports,
    private statusTimeoutMs = STATUS_TIMEOUT_MS,
  ) {}

  /** live agents plus closes still cleaning up */
  get size(): number {
    return this.agents.size + this.closing.size
  }

  /** Some agent (of that window, or any) has a live process that closing would stop. */
  anyLive(ownerId?: number): boolean {
    return [...this.agents.values()].some((a) => (ownerId === undefined || a.ownerId === ownerId) && needsCloseConfirm(a.state))
  }

  /** Some spawn has not finished: its agent has no card yet. */
  get spawning(): boolean {
    return this.pending.size > 0
  }

  idsOf(ownerId: number): string[] {
    return [...this.agents.values()].filter((a) => a.ownerId === ownerId).map((a) => a.id)
  }

  has(ownerId: number, id: string): boolean {
    return this.agents.get(id)?.ownerId === ownerId
  }

  /** Read-only views for flows and the MCP tools. */
  get(ownerId: number, id: string): Readonly<Agent> | undefined {
    const a = this.agents.get(id)
    return a?.ownerId === ownerId ? a : undefined
  }

  /** The agent an MCP token names, whatever its window (the token is the only identity). */
  byId(id: string): Readonly<Agent> | undefined {
    return this.agents.get(id)
  }

  list(ownerId: number): Readonly<Agent>[] {
    return [...this.agents.values()].filter((a) => a.ownerId === ownerId)
  }

  /** report_status: the agent's own short status line. */
  setReport(ownerId: number, id: string, text: string): void {
    this.owned(ownerId, id).report = text
  }

  /** The agent's process is alive, so closing it needs the user's confirmation. */
  needsStop(ownerId: number, id: string): boolean {
    const a = this.agents.get(id)
    return a?.ownerId === ownerId && needsCloseConfirm(a.state)
  }

  private owned(ownerId: number, id: string): Agent {
    const a = this.agents.get(id)
    if (!a || a.ownerId !== ownerId) throw new AgentError('Unknown agent')
    return a
  }

  /** SpawnAgent: worktree, status hooks, then the adapter's command in a PTY; everything is rolled back if the spawn fails. */
  async spawn(ownerId: number, repo: Repo | null, req: SpawnRequest): Promise<SpawnedAgent> {
    if (!repo) throw new AgentError('Open a repository first')
    if (!isValidRole(req.role)) throw new AgentError('Invalid role')
    return this.reserving(ownerId, undefined, (name) => this.spawnNamed(ownerId, repo, req, name))
  }

  /** A saved agent comes back: same worktree, branch, name (unless another live agent took it), role and model; never removes its worktree on failure. */
  async restore(ownerId: number, req: RestoreRequest): Promise<SpawnedAgent> {
    if (!isValidRole(req.role)) throw new AgentError('Invalid role')
    return this.reserving(ownerId, req.name, (name) => this.spawnNamed(ownerId, null, req, name, req))
  }

  /** The name is reserved before the first await so concurrent spawns cannot pick the same one. */
  private async reserving(ownerId: number, wanted: string | undefined, run: (name: string) => Promise<SpawnedAgent>): Promise<SpawnedAgent> {
    const taken = [...this.agents.values(), ...this.pending].filter((x) => x.ownerId === ownerId).map((x) => x.name)
    const name = wanted && !taken.some((t) => t.toLowerCase() === wanted.toLowerCase()) ? wanted : pickAgentName(taken)
    const slot = { ownerId, name }
    this.pending.add(slot)
    try {
      return await run(name)
    } finally {
      this.pending.delete(slot)
    }
  }

  private async spawnNamed(ownerId: number, repo: Repo | null, req: SpawnRequest, name: string, saved?: RestoreRequest): Promise<SpawnedAgent> {
    const wt = saved ? saved.worktree : await this.p.worktrees.add(repo!, req.role)
    const sessionId = saved && saved.resume ? saved.sessionId : randomUUID()
    const dirKey = saved ? randomUUID() : sessionId // per-agent hook/MCP files; never the dir of an earlier run
    let id: string | undefined
    let hooks: ReturnType<Ports['hooks']['open']> | undefined
    let mcp: ReturnType<NonNullable<Ports['mcp']>['open']> | undefined
    try {
      // events can only arrive once the process runs, i.e. after `id` is known
      hooks = this.p.hooks.open(dirKey, (s) => id !== undefined && this.signal(id, s))
      mcp = this.p.mcp?.open(dirKey, () => id)
      const cmd = this.p.adapter.buildSpawn({ cwd: wt.path, role: req.role, model: req.model, systemPrompt: req.systemPrompt, mcpConfig: mcp?.configPath, sessionId, resumeId: saved?.resume ? sessionId : undefined, hooks: { settingsPath: hooks.settingsPath, env: hooks.env } })
      id = this.p.ptys.spawnCommand(ownerId, req.cols, req.rows, { file: cmd.cmd, args: cmd.args, env: cmd.env, cwd: wt.path })
    } catch (e) {
      mcp?.close()
      hooks?.close()
      if (!saved) await this.p.worktrees.remove(wt) // a saved worktree stays for the next try
      throw e
    }
    const a: Agent = { id, ownerId, adapterId: this.p.adapter.id, role: req.role, name, model: req.model, sessionId, worktree: wt, state: 'starting', statusUnavailable: false, workspaceId: req.workspaceId, presetId: req.presetId, systemPrompt: req.systemPrompt }
    this.agents.set(id, a)
    const closeHooks = hooks.close
    this.hookClosers.set(id, () => {
      mcp?.close() // revokes the agent's MCP token
      closeHooks()
    })
    this.signal(id, { type: 'spawned' })
    if (a.state === 'starting') this.statusTimers.set(id, setTimeout(() => this.statusTimeout(a), this.statusTimeoutMs))
    return { id, name, role: req.role, branch: wt.branch, model: req.model ?? 'default', state: a.state, statusUnavailable: a.statusUnavailable }
  }

  /** Hooks disabled (by the user or a policy): the process runs but never reports. State stays honest; prompts get allowed. */
  private statusTimeout(a: Agent): void {
    this.statusTimers.delete(a.id)
    if (this.agents.get(a.id) !== a || a.state !== 'starting' || this.heard.has(a.id)) return
    a.statusUnavailable = true
    this.p.onState?.(a.ownerId, a.id, a.state, true)
  }

  /** Process facts and the agent's own events, through the adapter's state mapping. Unknown or closed agents are ignored. */
  signal(id: string, s: AgentSignal): void {
    const a = this.agents.get(id)
    if (!a) return
    const wasUnavailable = a.statusUnavailable
    const prev = a.state
    if (s.type === 'hook') {
      this.heard.add(id)
      a.statusUnavailable = false // late, but hooks do work
      if (s.event === 'SessionStart' && a.sessionId !== s.sessionId) {
        a.sessionId = s.sessionId // a new session after /clear, or a resumed one
        this.p.onSession?.(a.ownerId, id)
      }
      if (s.transcriptPath && s.sessionId === a.sessionId) a.transcriptPath = s.transcriptPath
    }
    const next = this.p.adapter.detectState(a.state, s)
    if (next !== a.state || a.statusUnavailable !== wasUnavailable) {
      a.state = next
      this.p.onState?.(a.ownerId, id, next, a.statusUnavailable)
    }
    if (s.type === 'hook' && s.event === 'UserPromptSubmit') this.p.onPromptSubmit?.(a.ownerId, id)
    const byStop = s.type === 'hook' && s.event === 'Stop'
    if (next === 'idle' && (byStop || prev !== 'idle')) this.p.onIdle?.(a.ownerId, id, byStop)
  }

  /** SubmitPrompt: through the adapter (bracketed paste for Claude); refused while starting (an Enter could answer the trust dialog) unless live status is unavailable, and once the PTY is gone. */
  async submitPrompt(ownerId: number, id: string, text: string, extra?: SubmitGuard): Promise<void> {
    const a = this.owned(ownerId, id)
    if (a.state === 'starting' && !a.statusUnavailable) throw new AgentError('Agent is still starting; answer its terminal first')
    // it may be showing a permission dialog, whose highlighted answer the Enter would pick; working is fine (the CLI queues it)
    const guard = () => (this.agents.get(id) !== a ? 'Agent is not running' : a.state === 'waiting' ? 'Answer in the terminal first' : (extra?.() ?? null))
    const why = guard()
    if (why) throw new AgentError(why)
    return this.p.adapter.submitPrompt(this.p.ptys.handle(ownerId, id), text, guard)
  }

  /** Whether a message may be typed in now: only when idle; working or waiting means later; the rest never (completes "<name> ..."). */
  readiness(ownerId: number, id: string): 'idle' | 'busy' | { refused: string } {
    const a = this.agents.get(id)
    if (!a || a.ownerId !== ownerId || a.state === 'exited' || a.state === 'error') return { refused: 'is not running' }
    if (a.state === 'starting') return { refused: 'is still starting' }
    return a.state === 'idle' ? 'idle' : 'busy'
  }

  /**
   * A message from a flow or another agent: written only while the agent is idle, checked again right before the paste and before
   * the Enter (with `extra`, e.g. Pause all). Never while starting, even with live status unavailable (its Enter could answer the
   * trust dialog), never while working or waiting (a permission dialog). The error completes "<name> ...".
   */
  async inject(ownerId: number, id: string, text: string, extra?: SubmitGuard): Promise<void> {
    this.owned(ownerId, id)
    const guard = () => {
      const r = this.readiness(ownerId, id)
      return r === 'idle' ? (extra?.() ?? null) : r === 'busy' ? 'is busy' : r.refused
    }
    const why = guard()
    if (why) throw new AgentError(why)
    return this.p.adapter.submitPrompt(this.p.ptys.handle(ownerId, id), text, guard)
  }

  /** ReadLastMessage: the adapter's source of truth (Claude transcript), else a best-effort scrape of the terminal. */
  async lastMessage(ownerId: number, id: string): Promise<LastMessage> {
    const a = this.owned(ownerId, id)
    const text = await this.p.adapter.readLastMessage({ sessionId: a.sessionId, transcriptPath: a.transcriptPath }).catch(() => null)
    if (text) return { text, source: 'transcript' }
    const scraped = this.p.ptys.recentText(ownerId, id)
    return scraped ? { text: scraped, source: 'scrape' } : { text: null, source: 'none' }
  }

  /**
   * The reply of the turn that just ended, for whoever acts on a Stop (edges, loops, handoff). Claude Code fires Stop a moment
   * before the reply reaches the transcript (about 100 ms, measured with 2.1.325), so it is awaited for up to ~3 s; an older
   * reply is never returned in its place. Null when the turn left no text. Never a scrape of the screen.
   */
  async turnReply(ownerId: number, id: string): Promise<string | null> {
    const a = this.owned(ownerId, id)
    if (!a.transcriptPath) return null
    for (const wait of [0, 50, 100, 200, 400, 800, 1500]) {
      if (wait) await new Promise((r) => setTimeout(r, wait))
      if (this.agents.get(id) !== a) return null // closed meanwhile
      const text = await this.p.adapter.readLastMessage({ sessionId: a.sessionId, transcriptPath: a.transcriptPath }, true).catch(() => null)
      if (text) return text
    }
    return null
  }

  /** CloseAgent: ask `confirmStop` first when the process is still alive, then stop it, drop its hooks, then apply the worktree removal policy (dirty work only goes on explicit Discard). */
  async close(ownerId: number, id: string, confirm?: ConfirmDiscard, confirmStop?: (a: { name: string; role: string }) => Promise<boolean>, keepWorktree = false): Promise<RemovalOutcome | 'cancelled' | 'stopped'> {
    const a = this.owned(ownerId, id)
    if (confirmStop && needsCloseConfirm(a.state) && !(await confirmStop({ name: a.name, role: a.role }))) return 'cancelled'
    if (this.agents.get(id) !== a) throw new AgentError('Unknown agent') // closed meanwhile, while the dialog was open
    this.agents.delete(id) // a second close of the same agent is now "unknown"; its late events are dropped
    const closeHooks = this.hookClosers.get(id)
    this.hookClosers.delete(id)
    clearTimeout(this.statusTimers.get(id))
    this.statusTimers.delete(id)
    this.heard.delete(id)
    const run = this.p.ptys
      .kill(ownerId, id)
      .catch(() => undefined) // may already have exited
      .then(() => {
        try {
          closeHooks?.()
        } catch {
          // a leftover settings file must not block the worktree policy
        }
        // leaving the app or the project: the worktree stays for the agent to be resumed in it
        return keepWorktree ? ('stopped' as const) : this.p.worktrees.remove(a.worktree, confirm)
      })
    this.closing.add(run)
    try {
      return await run
    } finally {
      this.closing.delete(run)
    }
  }

  /** Stops the agent and drops it, keeping its worktree and branch as they are (leaving the app or the project). */
  stop(ownerId: number, id: string): Promise<RemovalOutcome | 'cancelled' | 'stopped'> {
    return this.close(ownerId, id, undefined, undefined, true)
  }

  /** Window gone or app quitting: no dialog, never forced, worktrees kept (they are on the saved board); also waits for closes already running. */
  async closeAll(ownerId?: number): Promise<void> {
    const mine = [...this.agents.values()].filter((a) => ownerId === undefined || a.ownerId === ownerId)
    await Promise.allSettled([...mine.map((a) => this.stop(a.ownerId, a.id)), ...this.closing])
  }
}

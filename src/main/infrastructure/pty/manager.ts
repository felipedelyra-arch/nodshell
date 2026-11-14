import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { EventName, EventPayload } from '../../../shared/ipc/channels'
import type { PromptPty } from '../../domain/adapter'
import { MAX_LIVE } from '../../../shared/agent'
import { IpcError } from '../../ipc/validate'
import { validateCwd } from './cwd'
import { scrapeText, TAIL_MAX } from './scrape'
import { pidsInSession, signal } from './session'
import { filterEnv, pickShell } from './shell'

export const MAX_PTYS = MAX_LIVE
export const PAUSED_MESSAGE = 'Everything is paused, resume all first'
const FLUSH_MS = 8
// Flow control: pause the PTY while the renderer is this many characters behind.
const HIGH_WATERMARK = 400_000
const LOW_WATERMARK = 100_000

/** The subset of node-pty's IPty the manager needs. */
export type PtyProc = {
  pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
}
export type AgentCommand = { file: string; args: string[]; env: Record<string, string>; cwd: string }
export type SpawnPty = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyProc

export type Timing = {
  graceMs: number // SIGHUP -> SIGKILL
  hardMs: number // give up waiting for exit
  signal: (pid: number, sig: NodeJS.Signals, group?: boolean) => void
  sessionPids: (sid: number) => number[]
}
const DEFAULT_TIMING: Timing = { graceMs: 800, hardMs: 2000, signal, sessionPids: pidsInSession }

type Send = <E extends EventName>(ownerId: number, event: E, payload: EventPayload<E>) => void
/** `paused`: flow control (node-pty stops reading); `stopped`: the processes got SIGSTOP (Pause all). */
type Entry = { id: string; ownerId: number; proc: PtyProc; buf: string; tail: string; timer?: NodeJS.Timeout; killing: boolean; exited: Promise<void>; unacked: number; paused: boolean; stopped: boolean }

export class PtyManager {
  private ptys = new Map<string, Entry>()
  /** Live-terminal limit; lowering it below the running count kills nothing, it only refuses new ones. */
  limit = MAX_PTYS
  private stoppedOwners = new Set<number>()
  private counter = 0
  constructor(
    private send: Send,
    private spawnPty: SpawnPty,
    private t: Timing = DEFAULT_TIMING,
  ) {}

  get size(): number {
    return this.ptys.size
  }

  idsOf(ownerId: number): string[] {
    return [...this.ptys.values()].filter((e) => e.ownerId === ownerId).map((e) => e.id)
  }

  owns(ownerId: number, id: string): boolean {
    return this.ptys.get(id)?.ownerId === ownerId
  }

  /** Console: the user's login shell in $HOME. */
  spawn(ownerId: number, cols: number, rows: number): { id: string; name: string } {
    this.checkLimit(ownerId)
    const home = homedir()
    let cwd: string
    try {
      cwd = validateCwd(home, [home])
    } catch {
      throw new IpcError('Invalid working directory')
    }
    let shells = ''
    try {
      shells = readFileSync('/etc/shells', 'utf8')
    } catch {
      // fall back to /bin/bash
    }
    const shell = pickShell(process.env['SHELL'], shells)
    const id = this.start(ownerId, this.spawnPty(shell, [], { cols, rows, cwd, env: filterEnv(process.env) }))
    return { id, name: `console-${++this.counter}` }
  }

  /** Agent: a command already validated by its adapter, with a cwd validated by the caller. Counts toward the same limit. */
  spawnCommand(ownerId: number, cols: number, rows: number, c: AgentCommand): string {
    this.checkLimit(ownerId)
    return this.start(ownerId, this.spawnPty(c.file, c.args, { cols, rows, cwd: c.cwd, env: c.env }))
  }

  private checkLimit(ownerId: number): void {
    if (this.stoppedOwners.has(ownerId)) throw new IpcError(PAUSED_MESSAGE) // nothing starts while everything is paused
    if (this.ptys.size >= this.limit) throw new IpcError(`Terminal limit reached (${this.limit})`)
  }

  /** Pause all ran for this window: its terminals are stopped. */
  isStopped(ownerId: number): boolean {
    return this.stoppedOwners.has(ownerId)
  }

  /** Pause all: SIGSTOP to each terminal's process group, then to the rest of its session (a console's foreground job has its own group). */
  stopOwned(ownerId: number): void {
    this.stoppedOwners.add(ownerId)
    for (const e of this.ptys.values()) if (e.ownerId === ownerId && !e.killing) this.freeze(e, true)
  }

  /** Resume all: SIGCONT to the same processes, the rest of the session first so the shell never sees its job stopped. */
  contOwned(ownerId: number): void {
    this.stoppedOwners.delete(ownerId)
    for (const e of this.ptys.values()) if (e.ownerId === ownerId && e.stopped) this.freeze(e, false)
  }

  private freeze(e: Entry, stop: boolean): void {
    const pid = e.proc.pid
    const others = this.t.sessionPids(pid).filter((p) => p !== pid)
    if (stop) this.t.signal(pid, 'SIGSTOP', true)
    for (const p of others) this.t.signal(p, stop ? 'SIGSTOP' : 'SIGCONT')
    if (!stop) this.t.signal(pid, 'SIGCONT', true)
    e.stopped = stop
  }

  private start(ownerId: number, proc: PtyProc): string {
    const id = randomUUID()
    let resolveExit!: () => void
    const exited = new Promise<void>((r) => (resolveExit = r))
    const entry: Entry = { id, ownerId, proc, buf: '', tail: '', killing: false, exited, unacked: 0, paused: false, stopped: false }
    this.ptys.set(id, entry)

    proc.onData((d) => {
      entry.buf += d
      entry.tail = (entry.tail + d).slice(-TAIL_MAX)
      entry.timer ??= setTimeout(() => this.flush(entry), FLUSH_MS)
    })
    proc.onExit(({ exitCode }) => {
      this.flush(entry)
      this.ptys.delete(id)
      resolveExit()
      if (!entry.killing) this.send(ownerId, 'pty:exit', { id, code: exitCode })
    })
    return id
  }

  /** Write access for prompt submission; ownership is checked here, liveness on every use. */
  handle(ownerId: number, id: string): PromptPty {
    const e = this.owned(ownerId, id)
    return {
      key: id,
      alive: () => this.ptys.get(id) === e && !e.killing,
      write: (data) => {
        if (this.ptys.get(id) === e && !e.killing) e.proc.write(data)
      },
    }
  }

  /** Scrape fallback: cleaned last lines of the PTY output (bounded), or '' once the PTY is gone. */
  recentText(ownerId: number, id: string): string {
    const e = this.ptys.get(id)
    return e && e.ownerId === ownerId ? scrapeText(e.tail) : ''
  }

  /** Leader pid of every terminal (for the memory total). */
  pids(): number[] {
    return [...this.ptys.values()].filter((e) => !e.killing).map((e) => e.proc.pid)
  }

  private flush(e: Entry): void {
    clearTimeout(e.timer)
    e.timer = undefined
    if (!e.buf) return
    const data = e.buf
    e.buf = ''
    this.send(e.ownerId, 'pty:data', { id: e.id, data })
    e.unacked += data.length
    if (!e.paused && !e.killing && e.unacked > HIGH_WATERMARK) {
      e.paused = true
      e.proc.pause()
    }
  }

  /** Renderer reports `bytes` characters processed; resumes the PTY once it has caught up. */
  ack(ownerId: number, id: string, bytes: number): void {
    const e = this.owned(ownerId, id)
    e.unacked = Math.max(0, e.unacked - bytes)
    if (e.paused && !e.killing && e.unacked < LOW_WATERMARK) {
      e.paused = false
      e.proc.resume()
    }
  }

  private owned(ownerId: number, id: string): Entry {
    const e = this.ptys.get(id)
    if (!e || e.ownerId !== ownerId) throw new IpcError('Unknown terminal')
    return e
  }

  write(ownerId: number, id: string, data: string): void {
    const e = this.owned(ownerId, id)
    if (!e.killing) e.proc.write(data)
  }

  resize(ownerId: number, id: string, cols: number, rows: number): void {
    const e = this.owned(ownerId, id)
    if (!e.killing) e.proc.resize(cols, rows)
  }

  /** The shell still runs a program (a child in its session, background jobs included). Linux /proc only; elsewhere always false. */
  busy(ownerId: number, id: string): boolean {
    return this.running(this.owned(ownerId, id))
  }

  /** Some terminal (of that window, or any) still runs a program. */
  anyBusy(ownerId?: number): boolean {
    return [...this.ptys.values()].some((e) => (ownerId === undefined || e.ownerId === ownerId) && this.running(e))
  }

  private running(e: Entry): boolean {
    return !e.killing && this.t.sessionPids(e.proc.pid).some((p) => p !== e.proc.pid)
  }

  async kill(ownerId: number, id: string): Promise<void> {
    await this.terminate(this.owned(ownerId, id))
  }

  async killOwned(ownerId: number): Promise<void> {
    this.stoppedOwners.delete(ownerId)
    await Promise.all([...this.ptys.values()].filter((e) => e.ownerId === ownerId).map((e) => this.terminate(e)))
  }

  async killAll(): Promise<void> {
    this.stoppedOwners.clear()
    await Promise.all([...this.ptys.values()].map((e) => this.terminate(e)))
  }

  /** SIGHUP to the process group, SIGKILL to group and session after the grace period; never waits past hardMs. */
  private async terminate(e: Entry): Promise<void> {
    if (e.killing) return e.exited
    e.killing = true
    const { signal: sig, sessionPids, graceMs, hardMs } = this.t
    const pid = e.proc.pid
    if (e.paused) e.proc.resume() // a paused PTY may not report its exit
    if (e.stopped) this.freeze(e, false) // a stopped process would only take the hangup once continued
    sig(pid, 'SIGHUP', true)
    const sweep = () => {
      sig(pid, 'SIGKILL', true)
      for (const p of sessionPids(pid)) sig(p, 'SIGKILL')
    }
    const graceTimer = setTimeout(sweep, graceMs)
    let hardTimer: NodeJS.Timeout | undefined
    const gaveUp = new Promise<void>((r) => (hardTimer = setTimeout(r, hardMs)))
    await Promise.race([e.exited, gaveUp])
    clearTimeout(graceTimer)
    clearTimeout(hardTimer)
    // children that outlived the shell (e.g. ignoring SIGHUP) are still in the session
    for (const p of sessionPids(pid)) sig(p, 'SIGKILL')
    this.ptys.delete(e.id)
  }
}

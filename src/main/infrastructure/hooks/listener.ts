import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { HookSignal } from '../../domain/adapter'
import { envelopeSchema, hookEventSchema, MAX_LINE, toSignal } from './schema'

const PREFIX = 'agent-canvas-hooks-'
const SOCKET = 'hooks.sock'
/** sun_path is 108 bytes on Linux; keep a margin */
const MAX_SOCKET_PATH = 100
const CONN_TIMEOUT_MS = 2000
const RATE_WINDOW_MS = 1000
const RATE_MAX = 50

type Reg = { token: Buffer; onEvent: (s: HookSignal) => void; windowStart: number; count: number }
export type Registration = { token: string; close(): void }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** First of $XDG_RUNTIME_DIR, the OS temp dir and /tmp whose socket path fits; stale dirs of dead app processes are removed there. */
export function pickBaseDir(candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (!c || !isAbsolute(c) || !existsSync(c)) continue
    if (Buffer.byteLength(join(c, `${PREFIX}${process.pid}-XXXXXX`, SOCKET)) <= MAX_SOCKET_PATH) return c
  }
  throw new Error('No directory for the hook socket')
}

function removeStale(base: string): void {
  const uid = process.getuid?.()
  for (const name of readdirSync(base)) {
    const m = new RegExp(`^${PREFIX}(\\d+)-`).exec(name)
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue
    try {
      const st = lstatSync(join(base, name))
      if (st.isDirectory() && st.uid === uid) rmSync(join(base, name), { recursive: true, force: true })
    } catch {
      // gone meanwhile
    }
  }
}

/**
 * Unix socket in a private 0700 directory, socket 0600. Agents are identified ONLY by their per-agent token
 * (constant-time compare); one message per connection, bounded line, timeout, per-agent rate limit, Zod on every event.
 * Nothing is ever written back, and nothing is logged.
 */
export class HookListener {
  private regs = new Set<Reg>()
  private constructor(
    private server: Server,
    readonly dir: string,
    readonly socketPath: string,
  ) {}

  static async start(baseDir: string): Promise<HookListener> {
    removeStale(baseDir)
    const dir = mkdtempSync(join(baseDir, `${PREFIX}${process.pid}-`)) // created 0700
    chmodSync(dir, 0o700)
    const socketPath = join(dir, SOCKET)
    const server = createServer()
    server.maxConnections = 64
    const l = new HookListener(server, dir, socketPath)
    server.on('connection', (s) => l.onConnection(s))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => resolve())
      })
      chmodSync(socketPath, 0o600)
    } catch (e) {
      l.close()
      throw e
    }
    return l
  }

  /** A fresh 32-byte token bound to `onEvent`; `close()` revokes it so later events are dropped. */
  register(onEvent: (s: HookSignal) => void): Registration {
    const token = randomBytes(32).toString('hex')
    const reg: Reg = { token: Buffer.from(token), onEvent, windowStart: 0, count: 0 }
    this.regs.add(reg)
    return { token, close: () => void this.regs.delete(reg) }
  }

  private onConnection(s: Socket): void {
    s.setTimeout(CONN_TIMEOUT_MS, () => s.destroy())
    s.on('error', () => undefined)
    const chunks: Buffer[] = []
    let size = 0
    s.on('data', (c: Buffer) => {
      const nl = c.indexOf(0x0a)
      size += nl === -1 ? c.length : nl
      if (size > MAX_LINE) return void s.destroy()
      if (nl === -1) return void chunks.push(c)
      chunks.push(c.subarray(0, nl))
      s.destroy() // one message per connection
      this.handleLine(Buffer.concat(chunks).toString('utf8'))
    })
  }

  /** Exposed for tests; the socket path is the only production entry. */
  handleLine(line: string): boolean {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return false
    }
    const env = envelopeSchema.safeParse(raw)
    if (!env.success) return false
    const given = Buffer.from(env.data.token)
    let reg: Reg | undefined
    for (const r of this.regs) if (timingSafeEqual(r.token, given)) reg = r // both are 64 hex chars
    if (!reg) return false
    const now = Date.now()
    if (now - reg.windowStart > RATE_WINDOW_MS) {
      reg.windowStart = now
      reg.count = 0
    }
    if (++reg.count > RATE_MAX) return false
    const ev = hookEventSchema.safeParse(env.data.event)
    if (!ev.success) return false
    reg.onEvent(toSignal(ev.data))
    return true
  }

  /** Stops listening and removes the socket and its directory (synchronous: safe in will-quit). */
  close(): void {
    this.regs.clear()
    this.server.close()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

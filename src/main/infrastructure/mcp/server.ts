import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { z } from 'zod'

/** One JSON-RPC message per line, `{token, message}\n`; a longer line closes the connection. */
export const MCP_MAX_LINE = 256 * 1024 // a full memory_write (64 KiB of text, JSON-escaped) fits in one line
const MAX_QUEUED = 16 // lines waiting on one connection
const RATE_WINDOW_MS = 1000
const RATE_MAX = 20
/** what this server speaks when the client's version is not a date-like string */
const PROTOCOL = '2025-06-18'

const envelopeSchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/), message: z.unknown() })
const rpcId = z.union([z.string().max(128), z.number().int()])
const rpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: rpcId.optional(), method: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()).optional() })
const callSchema = z.object({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()).optional() })

export type ToolHost = {
  /** the tools this agent may see */
  list(agentId: string): { name: string; description: string; inputSchema: unknown }[]
  call(agentId: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }>
}
type Reg = { token: Buffer; agentId: () => string | undefined; windowStart: number; count: number }
type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const error = (id: Reply['id'], code: number, message: string): Reply => ({ jsonrpc: '2.0', id, error: { code, message } })

/**
 * The app side of the MCP bridge: a Unix socket (0600, in the hook listener's private 0700 directory) the per-agent relay talks to.
 * Every line carries the agent's 32-byte token (constant-time compare); without a valid, unrevoked token nothing runs.
 * Implements the minimum of MCP by hand: initialize, ping, tools/list, tools/call. Nothing is logged.
 */
export class McpServer {
  private regs = new Set<Reg>()
  private constructor(
    private server: Server,
    private host: ToolHost,
    readonly socketPath: string,
  ) {}

  static async start(socketPath: string, host: ToolHost): Promise<McpServer> {
    const server = createServer()
    server.maxConnections = 64
    const s = new McpServer(server, host, socketPath)
    server.on('connection', (c) => s.onConnection(c))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => resolve())
    })
    chmodSync(socketPath, 0o600)
    return s
  }

  /** A fresh token for the agent `agentId()` names; `close()` revokes it. */
  register(agentId: () => string | undefined): { token: string; close(): void } {
    const token = randomBytes(32).toString('hex')
    const reg: Reg = { token: Buffer.from(token), agentId, windowStart: 0, count: 0 }
    this.regs.add(reg)
    return { token, close: () => void this.regs.delete(reg) }
  }

  private onConnection(s: Socket): void {
    s.on('error', () => undefined)
    let buf = ''
    let queued = 0
    let chain = Promise.resolve()
    s.setEncoding('utf8')
    s.on('data', (c: string) => {
      buf += c
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.length > MCP_MAX_LINE || ++queued > MAX_QUEUED) return void s.destroy()
        // one at a time per connection, so replies keep the order of the requests
        chain = chain.then(async () => {
          const reply = await this.handleLine(line).catch(() => null)
          queued--
          if (reply && !s.destroyed) s.write(JSON.stringify(reply) + '\n')
        })
      }
      if (buf.length > MCP_MAX_LINE) s.destroy()
    })
  }

  /** Exposed for tests; the socket is the only production entry. Returns the JSON-RPC reply, or null for a notification. */
  async handleLine(line: string): Promise<Reply | null> {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return error(null, -32700, 'Parse error')
    }
    const looseId = (raw as { message?: { id?: unknown } } | null)?.message?.id
    const replyId = rpcId.safeParse(looseId).success ? (looseId as string | number) : null
    const env = envelopeSchema.safeParse(raw)
    const reg = env.success ? this.find(env.data.token) : undefined
    const agentId = reg?.agentId()
    if (!reg || !agentId) return error(replyId, -32001, 'Unauthorized')
    const now = Date.now()
    if (now - reg.windowStart > RATE_WINDOW_MS) [reg.windowStart, reg.count] = [now, 0]
    if (++reg.count > RATE_MAX) return error(replyId, -32002, 'Too many requests')
    const msg = rpcSchema.safeParse(env.data!.message)
    if (!msg.success) return error(replyId, -32600, 'Invalid request')
    const { id, method, params } = msg.data
    if (id === undefined) return null // a notification (e.g. notifications/initialized): nothing to answer
    switch (method) {
      case 'initialize': {
        const asked = params?.['protocolVersion']
        const version = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL
        return { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'agent-canvas', version: '1.0.0' } } }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: this.host.list(agentId) } }
      case 'tools/call': {
        const call = callSchema.safeParse(params)
        if (!call.success) return error(id, -32602, 'Invalid params')
        const r = await this.host.call(agentId, call.data.name, call.data.arguments ?? {})
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } }
      }
      default:
        return error(id, -32601, 'Method not found')
    }
  }

  private find(token: string): Reg | undefined {
    const given = Buffer.from(token)
    let found: Reg | undefined
    for (const r of this.regs) if (timingSafeEqual(r.token, given)) found = r // both are 64 hex chars; no early exit
    return found
  }

  close(): void {
    this.regs.clear()
    this.server.close()
  }
}

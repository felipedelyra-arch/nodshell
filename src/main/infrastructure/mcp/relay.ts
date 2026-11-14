// MCP relay, run by Claude Code as its stdio MCP server: `env ELECTRON_RUN_AS_NODE=1 <app binary> mcp-relay.js`.
// Each JSON-RPC line from stdin goes to the app's socket as one `{token, message}` line; each reply line goes back to stdout.
// Bounded lines, a reply timeout per request, and nothing is ever written to stderr. Self-contained on purpose: only Node built-ins.
import { connect } from 'node:net'

// = MCP_MAX_LINE in server.ts minus room for the `{token, message}` envelope, so a forwarded line never makes the app close the connection
const MAX_IN = 256 * 1024 - 256
const KEEP = 512 // of a dropped line, its start and end are kept to find its id
const MAX_OUT = 1024 * 1024 // replies carry at most a capped tool text
// above the app's own wait for the user on spawn_agent (SPAWN_ASK_MS in main), so its answer is never lost
const REPLY_TIMEOUT_MS = 120_000

const quit = (code: number): never => process.exit(code)
process.on('uncaughtException', () => quit(1))
process.stdout.on('error', () => quit(0))

const socketPath = process.env['NODSHELL_MCP_SOCKET']
const token = process.env['NODSHELL_MCP_TOKEN']
if (!socketPath || !token) quit(1)

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const waiting = new Map<unknown, ReturnType<typeof setTimeout>>()

/** Calls `onLine` for each complete line up to `max` characters; a longer one is skipped whole and `onTooLong` gets its start and end. */
function lines(stream: NodeJS.ReadableStream, max: number, onLine: (line: string) => void, onTooLong?: (head: string, tail: string) => void): void {
  let buf = ''
  let skipping: { head: string; tail: string } | null = null
  stream.setEncoding('utf8')
  stream.on('data', (c: string) => {
    buf += c
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (skipping) onTooLong?.(skipping.head, (skipping.tail + line).slice(-KEEP))
      else if (line.length > max) onTooLong?.(line.slice(0, KEEP), line.slice(-KEEP))
      else if (line.trim()) onLine(line)
      skipping = null
    }
    if (buf.length > max) {
      skipping = skipping ? { head: skipping.head, tail: (skipping.tail + buf).slice(-KEEP) } : { head: buf.slice(0, KEEP), tail: buf.slice(-KEEP) }
      buf = ''
    }
  })
}

/** The id of a request too long to parse: a top-level "id" written first or last (as MCP clients do), else null. */
function idOf(head: string, tail: string): string | number | null {
  const m = /"id"\s*:\s*(-?\d{1,15}|"[^"\\]{0,128}")\s*\}\s*$/.exec(tail) ?? /^\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(-?\d{1,15}|"[^"\\]{0,128}")/.exec(head)
  return m ? (JSON.parse(m[1]!) as string | number) : null
}

const sock = connect(socketPath as string)
sock.on('error', () => quit(1))
sock.on('close', () => quit(0))

lines(sock, MAX_OUT, (line) => {
  let reply: { id?: unknown }
  try {
    reply = JSON.parse(line) as { id?: unknown }
  } catch {
    return
  }
  clearTimeout(waiting.get(reply.id))
  waiting.delete(reply.id)
  out(reply)
})

lines(process.stdin, MAX_IN, (line) => {
  let msg: { id?: unknown; method?: unknown }
  try {
    msg = JSON.parse(line) as { id?: unknown; method?: unknown }
  } catch {
    return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const id = msg?.id
  if ((typeof id === 'string' || typeof id === 'number') && typeof msg.method === 'string' && !waiting.has(id)) {
    const t = setTimeout(() => {
      waiting.delete(id)
      out({ jsonrpc: '2.0', id, error: { code: -32000, message: 'The app did not answer' } })
    }, REPLY_TIMEOUT_MS)
    t.unref()
    waiting.set(id, t)
  }
  sock.write(JSON.stringify({ token, message: msg }) + '\n')
}, (head, tail) => out({ jsonrpc: '2.0', id: idOf(head, tail), error: { code: -32600, message: 'Request too large' } }))
process.stdin.on('end', () => sock.end())

// Hook relay, run by Claude Code as `env ELECTRON_RUN_AS_NODE=1 <app binary> hook-relay.js` with the hook JSON on stdin.
// Forwards a few fields to the app's socket as one `{token, event}` line, and ALWAYS exits 0 quickly with no output,
// so a missing or dead app can never block or break Claude. Self-contained on purpose: only Node built-ins.
import { connect } from 'node:net'

const FIELDS = ['hook_event_name', 'session_id', 'transcript_path', 'notification_type'] // = RELAYED_FIELDS in schema.ts
const MAX_INPUT = 8 * 1024 * 1024
const HARD_TIMEOUT_MS = 2000

const done = (): never => process.exit(0)
setTimeout(done, HARD_TIMEOUT_MS)
process.on('uncaughtException', done)
process.stdout.on('error', done)

const socketPath = process.env['NODSHELL_HOOK_SOCKET']
const token = process.env['NODSHELL_HOOK_TOKEN']
if (!socketPath || !token) done()

const chunks: Buffer[] = []
let size = 0
process.stdin.on('data', (c: Buffer) => {
  size += c.length
  if (size > MAX_INPUT) done()
  chunks.push(c)
})
process.stdin.on('error', done)
process.stdin.on('end', () => {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return done()
  }
  if (!input || typeof input !== 'object') return done()
  const event: Record<string, unknown> = {}
  for (const k of FIELDS) if (typeof input[k] === 'string') event[k] = input[k]
  const sock = connect(socketPath as string)
  sock.on('error', done)
  sock.on('close', done)
  sock.end(JSON.stringify({ token, event }) + '\n')
})

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { LAST_MESSAGE_MAX } from '../../../shared/agent'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHUNK = 64 * 1024
/** a single line longer than this is skipped, never buffered */
const MAX_LINE = 4 * 1024 * 1024
/** never scan more than this from the end of a transcript */
const MAX_SCAN = 32 * 1024 * 1024

/** `$CLAUDE_CONFIG_DIR/projects` when set (absolute), else `~/.claude/projects`. */
export function claudeProjectsDir(env: Record<string, string | undefined>, home: string): string {
  const cfg = env['CLAUDE_CONFIG_DIR']
  return cfg && isAbsolute(cfg) ? join(cfg, 'projects') : join(home, '.claude', 'projects')
}

/** Real path of the session's transcript, or null: must be `<sessionId>.jsonl`, a regular file, really inside `projectsDir`. */
export function validateTranscriptPath(p: string, sessionId: string, projectsDir: string): string | null {
  const name = `${sessionId}.jsonl`
  if (!UUID_RE.test(sessionId) || !isAbsolute(p) || p.includes('\0') || basename(p) !== name) return null
  try {
    const real = realpathSync(p)
    const root = realpathSync(projectsDir)
    if (!real.startsWith(root + sep) || basename(real) !== name) return null
    return real
  } catch {
    return null
  }
}

/**
 * Whether Claude Code has a transcript (a conversation to resume) for this session started in `cwd`: it keeps it at
 * `<projectsDir>/<cwd with every non-alphanumeric character as "-">/<sessionId>.jsonl`. Validated like any transcript path.
 */
export function hasTranscript(projectsDir: string, cwd: string, sessionId: string): boolean {
  if (!isAbsolute(cwd) || cwd.includes('\0')) return false
  return validateTranscriptPath(join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`), sessionId, projectsDir) !== null
}

const block = z.object({ type: z.string(), text: z.string().optional() })
const entrySchema = z.object({
  type: z.literal('assistant'),
  isSidechain: z.boolean().optional(),
  message: z.object({ id: z.string().optional(), content: z.union([z.string(), z.array(block)]) }),
})

type Parsed = { kind: 'assistant'; id: string | undefined; text: string } | { kind: 'user' } | { kind: 'other' }

function parseLine(line: string): Parsed {
  if (!line.includes('"assistant"') && !line.includes('"user"')) return { kind: 'other' } // cheap prefilter
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { kind: 'other' } // e.g. a last line still being written
  }
  const e = entrySchema.safeParse(raw)
  if (!e.success) {
    const t = raw as { type?: unknown; isSidechain?: unknown; isMeta?: unknown }
    return t && t.type === 'user' && t.isSidechain !== true && t.isMeta !== true ? { kind: 'user' } : { kind: 'other' }
  }
  if (e.data.isSidechain) return { kind: 'other' }
  const c = e.data.message.content
  const text = typeof c === 'string' ? c : c.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n')
  return { kind: 'assistant', id: e.data.message.id, text: text.trim() }
}

/** Lines from the end of the file, newest first, reading bounded chunks; over-long lines are skipped. */
function* linesFromEnd(fd: number, size: number): Generator<string> {
  let pos = size
  let carry = Buffer.alloc(0)
  let skipping = false
  const floor = Math.max(0, size - MAX_SCAN)
  while (pos > floor) {
    const len = Math.min(CHUNK, pos - floor)
    pos -= len
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, pos)
    const data = Buffer.concat([buf, carry])
    let end = data.length
    for (let i = data.lastIndexOf(0x0a, end - 1); i !== -1; i = data.lastIndexOf(0x0a, end - 1)) {
      if (skipping) skipping = false
      else if (end > i + 1) yield data.subarray(i + 1, end).toString('utf8')
      end = i
      if (end === 0) break
    }
    carry = data.subarray(0, end)
    if (carry.length > MAX_LINE) {
      carry = Buffer.alloc(0)
      skipping = true // the rest of this line, up to the previous newline, is dropped too
    }
  }
  if (!skipping && carry.length && pos === 0) yield carry.toString('utf8')
}

/** Text of the last main-thread assistant message (all its text blocks), skipping sidechains and tool-only entries; capped. */
export function readLastAssistantText(realPath: string): string | null {
  let fd: number
  try {
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    let found: { id: string | undefined; parts: string[] } | null = null
    for (const line of linesFromEnd(fd, st.size)) {
      const p = parseLine(line)
      if (!found) {
        if (p.kind === 'assistant' && p.text) found = { id: p.id, parts: [p.text] }
        continue
      }
      // earlier text blocks of the same API message belong to the same reply
      if (p.kind === 'user' || (p.kind === 'assistant' && (p.id === undefined || p.id !== found.id))) break
      if (p.kind === 'assistant' && p.text) found.parts.unshift(p.text)
    }
    return found ? found.parts.join('\n\n').slice(0, LAST_MESSAGE_MAX) : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

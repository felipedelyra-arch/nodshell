import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HookSignal } from '../../src/main/domain/adapter'
import { HookListener, pickBaseDir } from '../../src/main/infrastructure/hooks/listener'
import { HOOK_EVENTS, hookEventSchema, MAX_LINE } from '../../src/main/infrastructure/hooks/schema'
import { HookService, hookSettings, removeStaleSettings } from '../../src/main/infrastructure/hooks/settings'

const sid = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
const RELAY_SRC = resolve('src/main/infrastructure/hooks/relay.ts')

let tmp: string
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), 'hooks-test-'))))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('hook event schemas', () => {
  const ok = { hook_event_name: 'Stop', session_id: sid, transcript_path: '/h/.claude/projects/p/x.jsonl' }
  it('accepts the injected events and strips unknown fields', () => {
    for (const e of HOOK_EVENTS) {
      const r = hookEventSchema.safeParse({ ...ok, hook_event_name: e, notification_type: 'permission_prompt', extra: { x: 1 } })
      expect(r.success).toBe(true)
      expect(r.data).not.toHaveProperty('extra')
    }
    expect(hookEventSchema.safeParse({ hook_event_name: 'UserPromptSubmit', session_id: sid }).success).toBe(true) // transcript_path optional
  })
  it.each([
    ['missing session_id', { hook_event_name: 'Stop' }],
    ['missing event name', { session_id: sid }],
    ['unknown event', { ...ok, hook_event_name: 'PreToolUse' }],
    ['session_id not a uuid', { ...ok, session_id: '../../x' }],
    ['wrong type', { ...ok, transcript_path: 5 }],
    ['oversized transcript_path', { ...ok, transcript_path: '/' + 'a'.repeat(4096) }],
    ['Notification without its type', { ...ok, hook_event_name: 'Notification' }],
    ['oversized notification type', { ...ok, hook_event_name: 'Notification', notification_type: 'x'.repeat(65) }],
    ['not an object', 'Stop'],
  ])('rejects %s', (_n, e) => {
    expect(hookEventSchema.safeParse(e).success).toBe(false)
  })
})

describe('hook settings file', () => {
  const nasty = "/opt/my app/it's $HOME `x` \"q\""
  it('one exec-form command hook per event; paths are single argv entries, never shell-parsed', () => {
    const s = hookSettings(`${nasty}/electron`, `${nasty}/hook-relay.js`)
    expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const groups of Object.values(s.hooks)) {
      expect(groups).toEqual([
        { hooks: [{ type: 'command', command: '/usr/bin/env', args: ['ELECTRON_RUN_AS_NODE=1', `${nasty}/electron`, `${nasty}/hook-relay.js`], timeout: 5 }] },
      ])
    }
    expect(JSON.stringify(s)).not.toMatch(/dangerously|skip-permissions|permission/)
  })
  it.each([['relative', 'relay.js'], ['placeholder', '/a/${CLAUDE_PROJECT_DIR}/r.js'], ['NUL', '/a\0b']])('rejects a %s path', (_n, p) => {
    expect(() => hookSettings('/bin/electron', p)).toThrow()
  })

  it('HookService writes a 0600 file in a 0700 dir named by session, with a fresh token, and close removes both', async () => {
    const l = await HookListener.start(tmp)
    try {
      const base = join(tmp, 'agents')
      const svc = new HookService(l, base, '/bin/electron', `${nasty}/hook-relay.js`)
      const a = svc.open(sid, () => undefined)
      const b = svc.open('9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d', () => undefined)
      expect(a.settingsPath).toBe(join(base, sid, 'settings.json'))
      expect(statSync(a.settingsPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(base, sid)).mode & 0o777).toBe(0o700)
      expect(JSON.parse(readFileSync(a.settingsPath, 'utf8'))).toEqual(hookSettings('/bin/electron', `${nasty}/hook-relay.js`))
      expect(a.env.AGENT_CANVAS_HOOK_SOCKET).toBe(l.socketPath)
      expect(a.env.AGENT_CANVAS_HOOK_TOKEN).toMatch(/^[0-9a-f]{64}$/)
      expect(a.env.AGENT_CANVAS_HOOK_TOKEN).not.toBe(b.env.AGENT_CANVAS_HOOK_TOKEN)
      expect(readFileSync(a.settingsPath, 'utf8')).not.toContain(a.env.AGENT_CANVAS_HOOK_TOKEN!) // the token never touches disk
      expect(() => svc.open(sid, () => undefined)).toThrow() // never reuses or overwrites a file
      expect(() => svc.open('../x', () => undefined)).toThrow('Invalid session id')
      a.close()
      b.close()
      expect(existsSync(join(base, sid))).toBe(false)
    } finally {
      l.close()
    }
    expect(() => new HookService(null, tmp, '/e', '/r').open(sid, () => undefined)).toThrow('Agent status is unavailable')
  })
})

describe('HookListener (real Unix socket)', () => {
  let l: HookListener
  let got: HookSignal[]
  let token: string
  let other: string
  beforeAll(async () => {
    l = await HookListener.start(tmp)
    token = l.register((s) => got.push(s)).token
    other = l.register(() => undefined).token
  })
  afterAll(() => l.close())
  afterEach(() => void (got = []))
  got = []

  const send = (data: string | Buffer) =>
    new Promise<void>((done) => {
      const s = connect(l.socketPath)
      s.on('error', () => done())
      s.on('close', () => done())
      s.end(data)
    })
  const line = (t: unknown, event: unknown = { hook_event_name: 'Stop', session_id: sid }) => JSON.stringify({ token: t, event }) + '\n'
  const settle = () => new Promise((r) => setTimeout(r, 50))

  it('socket 0600 inside a private 0700 directory on a short path', () => {
    expect(statSync(l.dir).mode & 0o777).toBe(0o700)
    expect(statSync(l.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(l.socketPath).isSocket()).toBe(true)
    expect(Buffer.byteLength(l.socketPath)).toBeLessThanOrEqual(100)
  })

  it('a valid event reaches its registration, identified by token only', async () => {
    await send(line(token, { hook_event_name: 'Notification', session_id: sid, notification_type: 'permission_prompt', agent_id: 'someone-else' }))
    await settle()
    expect(got).toEqual([{ type: 'hook', event: 'Notification', sessionId: sid, transcriptPath: undefined, notificationType: 'permission_prompt' }])
  })

  it.each([
    ['no token', () => JSON.stringify({ event: { hook_event_name: 'Stop', session_id: sid } }) + '\n'],
    ['a wrong token', () => line('0'.repeat(64))],
    ['a short token', () => line(token.slice(0, 63))],
    ['another agent token', () => line(other)],
    ['malformed JSON', () => '{"token":\n'],
    ['an invalid event', () => line(token, { hook_event_name: 'Stop', session_id: 'nope' })],
    ['no newline', () => line(token).trimEnd()],
    ['an oversized line', () => line(token, { hook_event_name: 'Stop', session_id: sid, pad: 'x'.repeat(MAX_LINE) })],
  ])('rejects %s and changes nothing', async (_n, data) => {
    await send(data())
    await settle()
    expect(got).toEqual([])
  })

  it('one message per connection', async () => {
    await send(line(token) + line(token))
    await settle()
    expect(got).toHaveLength(1)
  })

  it('rate-limits a flood from one agent', () => {
    let n = 0
    for (let i = 0; i < 200; i++) if (l.handleLine(line(token).trimEnd())) n++
    expect(n).toBeLessThanOrEqual(50)
    got = []
  })

  it('a closed registration is dropped', async () => {
    const r = l.register(() => got.push({ type: 'hook', event: 'x', sessionId: sid }))
    r.close()
    expect(l.handleLine(line(r.token).trimEnd())).toBe(false)
    expect(got).toEqual([])
  })
})

describe('hook relay (child process, exec form as Claude runs it)', () => {
  const runRelay = (relay: string, env: Record<string, string>, stdin: string) =>
    new Promise<{ code: number | null; out: string; ms: number }>((done) => {
      const t0 = Date.now()
      const handler = hookSettings(process.execPath, relay).hooks['Stop']![0]!.hooks[0]!
      const p = execFile(handler.command, handler.args, { env: { PATH: process.env['PATH'] ?? '', ...env } }, (err, stdout, stderr) =>
        done({ code: err ? (err.code as number) : 0, out: stdout + stderr.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, ''), ms: Date.now() - t0 }),
      )
      p.stdin!.end(stdin)
    })

  let relay: string
  beforeAll(() => {
    const dir = join(tmp, "relay dir it's $HOME `x`")
    mkdirSync(dir)
    relay = join(dir, 'hook-relay.ts')
    copyFileSync(RELAY_SRC, relay)
  })

  it('delivers the event and forwards only the whitelisted fields', async () => {
    const l = await HookListener.start(tmp)
    const got: HookSignal[] = []
    const { token } = l.register((s) => got.push(s))
    try {
      const input = { hook_event_name: 'Stop', session_id: sid, transcript_path: '/t/x.jsonl', last_assistant_message: 'secret reply', cwd: '/w' }
      const r = await runRelay(relay, { AGENT_CANVAS_HOOK_SOCKET: l.socketPath, AGENT_CANVAS_HOOK_TOKEN: token }, JSON.stringify(input))
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
      await new Promise((res) => setTimeout(res, 50))
      expect(got).toEqual([{ type: 'hook', event: 'Stop', sessionId: sid, transcriptPath: '/t/x.jsonl', notificationType: undefined }])
    } finally {
      l.close()
    }
  })

  it.each([
    ['the socket does not exist', { AGENT_CANVAS_HOOK_SOCKET: '/nonexistent/hooks.sock', AGENT_CANVAS_HOOK_TOKEN: 'a'.repeat(64) }, '{"hook_event_name":"Stop"}'],
    ['no environment', {}, '{"hook_event_name":"Stop"}'],
    ['stdin is not JSON', { AGENT_CANVAS_HOOK_SOCKET: '/nonexistent/hooks.sock', AGENT_CANVAS_HOOK_TOKEN: 'a'.repeat(64) }, 'not json'],
  ])('exits 0 quickly and silently when %s', async (_n, env, stdin) => {
    const r = await runRelay(relay, env, stdin)
    expect(r).toMatchObject({ code: 0, out: '' })
    expect(r.ms).toBeLessThan(1500)
  })
})

describe('socket directory', () => {
  it('picks the first candidate whose socket path fits', () => {
    expect(pickBaseDir([undefined, 'relative', tmp])).toBe(tmp)
    expect(pickBaseDir(['/' + 'x'.repeat(120), '/tmp'])).toBe('/tmp')
    expect(() => pickBaseDir(['/nonexistent-dir-x'])).toThrow()
  })

  it('removes stale directories of dead app processes and keeps live ones', async () => {
    const base = mkdtempSync(join(tmp, 'base-'))
    const stale = join(base, 'agent-canvas-hooks-999999999-abc')
    const live = join(base, `agent-canvas-hooks-${process.ppid}-abc`)
    mkdirSync(stale)
    mkdirSync(live)
    const l = await HookListener.start(base)
    l.close()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(l.dir)).toBe(false) // close removes the socket and its dir
  })
})

describe('removeStaleSettings', () => {
  it('removes UUID-named directories only, never following a symlink', () => {
    const base = mkdtempSync(join(tmp, 'agents-'))
    const outside = mkdtempSync(join(tmp, 'outside-'))
    const victim = join(outside, 'keep.txt')
    writeFileSync(victim, 'x')
    const stale = join(base, sid)
    mkdirSync(stale)
    writeFileSync(join(stale, 'settings.json'), '{}')
    symlinkSync(outside, join(stale, 'link')) // inside a stale dir: the link goes, its target stays
    symlinkSync(outside, join(base, '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d')) // a UUID-named symlink is not a directory
    mkdirSync(join(base, 'not-a-uuid'))
    writeFileSync(join(base, '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'), 'a file')
    removeStaleSettings(base)
    expect(readdirSync(base).sort()).toEqual(['0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d', 'not-a-uuid'])
    expect(readFileSync(victim, 'utf8')).toBe('x')
    expect(() => removeStaleSettings(join(tmp, 'missing'))).not.toThrow()
  })
})

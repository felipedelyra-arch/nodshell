import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentAdapter } from '../../src/main/domain/adapter'
import { ClaudeAdapter, claudeEnv } from '../../src/main/infrastructure/adapters/claude'
import { GenericAdapter } from '../../src/main/infrastructure/adapters/generic'
import { which } from '../../src/main/infrastructure/which'

const sessionId = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
const resumeId = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d'

let dir: string, bin: string, noexec: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'adapter-test-'))
  bin = join(dir, 'bin')
  noexec = join(dir, 'noexec')
  mkdirSync(bin)
  mkdirSync(noexec)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(join(noexec, 'claude'), '#!/bin/sh\n') // not executable
  mkdirSync(join(noexec, 'git')) // a directory, not a file
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const adapter = () => new ClaudeAdapter({ PATH: `relative/bin:${noexec}:${bin}`, HOME: '/h' })
const base = { cwd: '/w', role: 'qa', sessionId }

describe('which', () => {
  it('returns the absolute path of the first executable file, skipping relative entries, dirs and non-executables', () => {
    expect(which('claude', `relative/bin:${noexec}:${bin}`)).toBe(join(bin, 'claude'))
    expect(which('git', noexec)).toBeUndefined()
    expect(which('../claude', bin)).toBeUndefined()
    expect(which('claude', undefined)).toBeUndefined()
  })
})

describe('ClaudeAdapter.buildSpawn', () => {
  it('minimal: absolute cmd and only the app-generated session id', () => {
    const s = adapter().buildSpawn(base)
    expect(s.cmd).toBe(join(bin, 'claude'))
    expect(s.args).toEqual([`--session-id=${sessionId}`])
  })
  it('every option as a single --opt=value argv entry', () => {
    const s = adapter().buildSpawn({ ...base, model: 'opus', systemPrompt: 'be brief', mcpConfig: '/tmp/mcp.json' })
    expect(s.args).toEqual(['--model=opus', '--append-system-prompt=be brief', '--mcp-config=/tmp/mcp.json', `--session-id=${sessionId}`])
  })
  it('resume replaces --session-id (the CLI rejects both together)', () => {
    const s = adapter().buildSpawn({ ...base, resumeId })
    expect(s.args).toEqual([`--resume=${resumeId}`])
  })
  it('never adds permission-skipping flags', () => {
    const s = adapter().buildSpawn({ ...base, model: 'sonnet', systemPrompt: 'x', mcpConfig: '{}', resumeId })
    for (const a of s.args) expect(a).not.toMatch(/dangerously|skip-permissions|permission-mode/)
  })
  it('a system prompt starting with "-" or holding quotes/newlines stays one argv value', () => {
    const sp = '--dangerously-skip-permissions\n"quoted" \'single\' $(rm -rf /) `x`'
    const s = adapter().buildSpawn({ ...base, systemPrompt: sp })
    expect(s.args).toEqual([`--append-system-prompt=${sp}`, `--session-id=${sessionId}`])
  })
  it.each([
    ['model starting with -', { model: '-x' }],
    ['model with space', { model: 'opus --x' }],
    ['model too long', { model: 'a'.repeat(65) }],
    ['bad role', { role: '../x' }],
    ['bad session id', { sessionId: '--version' }],
    ['bad resume id', { resumeId: '-r' }],
    ['NUL in system prompt', { systemPrompt: 'a\0b' }],
  ])('rejects %s', (_n, o) => {
    expect(() => adapter().buildSpawn({ ...base, ...o })).toThrow()
  })
  it('hooks: --settings before the session id, relay variables added after the env filter', () => {
    const hooks = { settingsPath: '/data/agents/x/settings.json', env: { NODSHELL_HOOK_SOCKET: '/run/s.sock', NODSHELL_HOOK_TOKEN: 'a'.repeat(64) } }
    const s = new ClaudeAdapter({ PATH: bin, NODSHELL_HOOK_TOKEN: 'inherited' }).buildSpawn({ ...base, model: 'haiku', hooks })
    expect(s.args).toEqual(['--model=haiku', '--settings=/data/agents/x/settings.json', `--session-id=${sessionId}`])
    expect(s.env).toEqual({ PATH: bin, TERM: 'xterm-256color', ...hooks.env })
  })
  it('fails clearly when claude is not on PATH', () => {
    expect(() => new ClaudeAdapter({ PATH: noexec }).buildSpawn(base)).toThrow('Claude Code not found on PATH')
  })
})

it('ClaudeAdapter falls back to ~/.local/bin when PATH has no claude (launched from the desktop menu)', () => {
  const home = join(dir, 'home')
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n')
  chmodSync(join(home, '.local', 'bin', 'claude'), 0o755)
  expect(new ClaudeAdapter({ PATH: noexec, HOME: home }).buildSpawn({ cwd: dir, role: 'backend', sessionId }).cmd).toBe(join(home, '.local', 'bin', 'claude'))
})

describe('claudeEnv', () => {
  it('applies the F1 filter and drops a parent Claude Code session', () => {
    const env = claudeEnv({
      HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', NODSHELL_TEST_REPO: '/r',
    })
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'k', TERM: 'xterm-256color' })
  })
  it('is what buildSpawn returns', () => {
    expect(new ClaudeAdapter({ PATH: bin, CLAUDECODE: '1' }).buildSpawn(base).env).toEqual({ PATH: bin, TERM: 'xterm-256color' })
  })
})

describe('adapters behind the same port', () => {
  it('GenericAdapter runs its fixed absolute command', () => {
    const g = new GenericAdapter('Shell', '/bin/sh', ['-i'], { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' })
    expect(g.buildSpawn(base)).toEqual({ cmd: '/bin/sh', args: ['-i'], env: { PATH: '/bin', TERM: 'xterm-256color' } })
    expect(() => new GenericAdapter('x', 'sh')).toThrow()
  })
  it('Claude waits for its session to start; the generic stub is ready at once', async () => {
    expect(adapter().detectState('starting', { type: 'spawned' })).toBe('starting')
    expect(new GenericAdapter('Shell', '/bin/sh').detectState('starting', { type: 'spawned' })).toBe('idle')
    for (const a of [adapter(), new GenericAdapter('Shell', '/bin/sh')] as AgentAdapter[]) {
      expect(a.detectState('idle', { type: 'exited', code: 1 })).toBe('error')
      expect(a.detectState('idle', { type: 'exited', code: 0 })).toBe('exited')
      await expect(a.readLastMessage({ sessionId })).resolves.toBeNull()
    }
  })
  it('maps Claude hook events to transitions', () => {
    const h = (event: string, notificationType?: string) => ({ type: 'hook' as const, event, sessionId, notificationType })
    const a = adapter()
    expect(a.detectState('starting', h('SessionStart'))).toBe('idle')
    expect(a.detectState('idle', h('UserPromptSubmit'))).toBe('working')
    expect(a.detectState('working', h('Notification', 'permission_prompt'))).toBe('waiting')
    expect(a.detectState('working', h('Notification', 'elicitation_dialog'))).toBe('waiting')
    expect(a.detectState('idle', h('Notification', 'idle_prompt'))).toBe('idle')
    expect(a.detectState('working', h('Notification', 'idle_prompt'))).toBe('idle') // after Esc there is no Stop
    expect(a.detectState('waiting', h('Notification', 'idle_prompt'))).toBe('idle')
    expect(a.detectState('working', h('StopFailure'))).toBe('idle') // API error ends the turn
    expect(a.detectState('exited', h('StopFailure'))).toBe('exited')
    expect(a.detectState('working', h('Notification', 'auth_success'))).toBe('working')
    expect(a.detectState('waiting', h('PostToolUse'))).toBe('working')
    expect(a.detectState('waiting', h('Stop'))).toBe('idle')
    expect(a.detectState('working', h('SubagentStop'))).toBe('working')
  })
})

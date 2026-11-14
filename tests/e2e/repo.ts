import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { tempDir } from './helpers'

export const START = '\x1b[200~'
export const END = '\x1b[201~'

export type Run = { argv: string[]; cwd: string; pid: number; claudeEnv: string[]; hookSocket: string }

/** A run's prompts, one string per submission (paste markers included). */
export const submissions = (logs: string, pid: number): string[] => {
  try {
    return readFileSync(join(logs, `${pid}.subs`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string)
  } catch {
    return []
  }
}

/**
 * A fake `claude`: records argv/cwd/env names and raw stdin, enables bracketed paste, reports each submission (Enter outside a paste).
 * Like Claude Code it reads its --settings file and runs the configured command hooks (exec form: argv, no shell; shell form: sh -c)
 * with the event JSON on stdin, waiting for them. SessionStart fires at start, or, with FAKE_TRUST_GATE=1, only after "y" is typed
 * (a trust dialog). Each submission is a turn: UserPromptSubmit, [IDLEPROMPT: only an idle_prompt Notification, as after Esc],
 * [PERMISSION: Notification, PostToolUse], transcript lines
 * (unless NOTRANSCRIPT) under $HOME/.claude/projects, an "ANSWER:" line on screen, then Stop. The answer is "FINAL ANSWER to <first line>",
 * or the text after "REPLY:" when the prompt has one. Like Claude Code it can talk MCP over stdio: "MCPCALL <tool> <json args>" in a
 * prompt runs the stdio server of its --mcp-config (initialize, notifications/initialized, tools/call), logs the reply to <pid>.mcp
 * and shows "MCP RESULT <text>" before answering. "GOAL:<text>" plays an Orchestrator: list_agents, then one send_message
 * "<text> part <i>" to each of the first two other non-Orchestrator agents (each reply logged and shown the same way).
 * "SLOW" makes the turn last about 4 s longer.
 */
export function fakeClaude(logs: string): string {
  return `#!${process.execPath}
const fs = require('fs'), path = require('path'), { spawn } = require('child_process')
const LOG = ${JSON.stringify(logs)}, START = '\\x1b[200~', END = '\\x1b[201~'
const pid = process.pid
const argv = process.argv.slice(2)
const opt = (n) => (argv.find((a) => a.startsWith('--' + n + '=')) || '').slice(n.length + 3)
const sid = opt('session-id') || opt('resume') // like Claude Code, a resumed session keeps its id
const settings = opt('settings') ? JSON.parse(fs.readFileSync(opt('settings'), 'utf8')) : { hooks: {} }
const transcript = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl')
const claudeEnv = Object.keys(process.env).filter((k) => /^CLAUDE/.test(k))
fs.writeFileSync(path.join(LOG, pid + '.json'), JSON.stringify({ argv, cwd: process.cwd(), pid, claudeEnv, hookSocket: process.env.AGENT_CANVAS_HOOK_SOCKET }))
// like Claude Code: nothing to resume without the session's transcript
if (opt('resume') && !fs.existsSync(transcript)) {
  process.stdout.write('No conversation found with session ID ' + opt('resume') + '\\r\\n')
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function fire(event, extra) {
  const input = JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: process.cwd(), hook_event_name: event, ...extra })
  const runs = []
  for (const g of (settings.hooks || {})[event] || []) for (const h of g.hooks) {
    if (h.type !== 'command') continue
    runs.push(new Promise((res) => {
      const p = h.args ? spawn(h.command, h.args, { stdio: ['pipe', 'ignore', 'ignore'] }) : spawn('sh', ['-c', h.command], { stdio: ['pipe', 'ignore', 'ignore'] })
      p.on('error', res)
      p.on('exit', res)
      p.stdin.on('error', () => undefined)
      p.stdin.end(input)
    }))
  }
  return Promise.all(runs)
}
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, ...o }) + '\\n')
function mcpCall(tool, args) {
  const server = JSON.parse(fs.readFileSync(opt('mcp-config'), 'utf8')).mcpServers['agent-canvas']
  return new Promise((done) => {
    const p = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    p.stdout.on('data', (c) => {
      buf += c
      const reply = buf.split('\\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2)
      if (reply) (p.stdin.end(), done(reply))
    })
    p.on('exit', () => done(null))
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
    ]
    p.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\\n') + '\\n')
  })
}
async function turn(prompt) {
  await fire('UserPromptSubmit', { prompt })
  await sleep(1200)
  if (prompt.includes('IDLEPROMPT')) return fire('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }) // interrupted: no Stop
  if (prompt.includes('PERMISSION')) {
    await fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
    await sleep(1500)
    await fire('PostToolUse', { tool_name: 'Bash' })
    await sleep(600)
  }
  if (prompt.includes('EXITNOW')) process.exit(0)
  const call = /MCPCALL (\\w+) (\\{.*\\})/.exec(prompt)
  if (call) {
    const r = await mcpCall(call[1], JSON.parse(call[2]))
    fs.appendFileSync(path.join(LOG, pid + '.mcp'), JSON.stringify(r) + '\\n')
    process.stdout.write('MCP RESULT ' + (r && r.result ? r.result.content[0].text : JSON.stringify(r && r.error)) + '\\r\\n')
  }
  const goal = /GOAL:(.*)/.exec(prompt)
  if (goal) {
    const log = (r) => {
      fs.appendFileSync(path.join(LOG, pid + '.mcp'), JSON.stringify(r) + '\\n')
      process.stdout.write('MCP RESULT ' + (r && r.result ? r.result.content[0].text : JSON.stringify(r && r.error)) + '\\r\\n')
    }
    const listed = await mcpCall('list_agents', {})
    log(listed)
    const others = JSON.parse(listed.result.content[0].text).filter((a) => !a.you && a.role !== 'orchestrator').slice(0, 2)
    for (let i = 0; i < others.length; i++) log(await mcpCall('send_message', { to: others[i].name, text: goal[1].trim() + ' part ' + (i + 1) }))
  }
  if (prompt.includes('SLOW')) await sleep(4000)
  const reply = /REPLY:(.*)/.exec(prompt)
  const answer = reply ? reply[1].trim() : 'FINAL ANSWER to ' + prompt.split('\\n')[0]
  if (!prompt.includes('NOTRANSCRIPT')) {
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    line({ type: 'user', message: { role: 'user', content: prompt } })
    line({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } })
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
    line({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: answer }] } })
    line({ type: 'assistant', isSidechain: true, message: { id: 's1', role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN NOISE' }] } })
  }
  process.stdout.write('ANSWER: ' + answer + '\\r\\n')
  await fire('Stop', { last_assistant_message: answer, stop_hook_active: false })
}
let gated = process.env.FAKE_TRUST_GATE === '1'
process.stdin.setRawMode(true)
process.stdout.write('\\x1b[?2004hFAKE CLAUDE READY\\r\\n' + (gated ? 'Do you trust this folder? Type y\\r\\n' : ''))
let turns = gated ? Promise.resolve() : fire('SessionStart', { source: 'startup' })
let pending = '', count = 0
process.stdin.on('data', (b) => {
  fs.appendFileSync(path.join(LOG, pid + '.stdin'), b)
  if (gated) {
    if (b.toString('latin1') === 'y') {
      gated = false
      process.stdout.write('TRUSTED\\r\\n')
      turns = turns.then(() => fire('SessionStart', { source: 'startup' }))
    }
    return
  }
  pending += b.toString('latin1')
  for (let i = 0; i < pending.length; i++) {
    if (pending[i] !== '\\r') continue
    const before = pending.slice(0, i)
    if (before.split(START).length !== before.split(END).length) continue // Enter inside a paste
    fs.appendFileSync(path.join(LOG, pid + '.subs'), JSON.stringify(before) + '\\n')
    process.stdout.write('SUBMITTED ' + ++count + '\\r\\n')
    const prompt = before.split(START).join('').split(END).join('')
    turns = turns.then(() => turn(prompt))
    pending = pending.slice(i + 1)
    i = -1
  }
})
`
}

export function setupRepo() {
  const work = tempDir('agent-canvas-e2e-repo-')
  const repo = join(work, 'demo repo')
  const bin = join(work, 'bin')
  const logs = join(work, 'logs')
  for (const d of [repo, bin, logs]) mkdirSync(d)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(bin, 'claude'), fakeClaude(logs))
  chmodSync(join(bin, 'claude'), 0o755)
  const env = { PATH: `${bin}:${process.env['PATH']}`, AGENT_CANVAS_TEST_REPO: repo }
  const runs = (): Run[] => readdirSync(logs).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(logs, f), 'utf8')) as Run)
  const agentBranches = () => git('for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/').split('\n').filter(Boolean)
  const worktreeCount = () => (git('worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length
  return { repo, logs, env, runs, agentBranches, worktreeCount }
}


export async function openRepo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open repository' }).click()
  await expect(page.getByTestId('repo-badge')).toHaveText('main')
}

export const spawnPill = (page: Page) => page.locator('button.pill', { hasText: /^Spawn \d+$/ })

/** Creates a preset through the real channel unless it exists (setup only; the Presets dialog has its own test). */
export async function ensurePreset(page: Page, p: { name: string; role: string; model: 'opus' | 'sonnet' | 'haiku' | null }): Promise<void> {
  await page.evaluate(async (p) => {
    const { presets } = await window.api.invoke('preset:list', undefined)
    if (!presets.some((x) => x.name === p.name)) await window.api.invoke('preset:save', { ...p, systemPrompt: '' })
  }, p)
}

/** Spawn pill -> popover: pick the preset, set the count with the stepper, spawn. */
export async function spawnPreset(page: Page, preset: string, count: number): Promise<void> {
  await spawnPill(page).click()
  const dlg = page.getByRole('dialog', { name: 'Spawn agents' })
  await dlg.getByLabel('Preset').selectOption({ label: preset })
  const shown = async () => Number(await dlg.getByTestId('spawn-count').textContent())
  while ((await shown()) < count) await dlg.getByRole('button', { name: 'More agents' }).click()
  while ((await shown()) > count) await dlg.getByRole('button', { name: 'Fewer agents' }).click()
  await dlg.getByRole('button', { name: `Spawn ${count}`, exact: true }).click()
}

/** Old F2 helper: one agent of an ad-hoc preset `<role> <model>` (role + model decide the name and argv). */
export async function spawnAgent(page: Page, role: string, model: 'opus' | 'sonnet' | 'haiku', total: number): Promise<void> {
  const name = `${role} ${model}`
  await ensurePreset(page, { name, role, model })
  await spawnPreset(page, name, 1)
  await expect(page.getByTestId('agent-node')).toHaveCount(total)
}

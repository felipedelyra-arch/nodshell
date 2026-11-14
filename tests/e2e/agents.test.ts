import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { cleanupTemp, expectGone, launch } from './helpers'
import { END, openRepo, setupRepo, spawnAgent, spawnPill, START } from './repo'

test.afterEach(cleanupTemp)

test('two agents in distinct worktrees, one multiline submission, complete cleanup', async () => {
  test.setTimeout(90_000)
  const r = setupRepo()
  const { app, page, tmp, errors } = await launch(r.env)
  try {
    // Spawn is visibly disabled until a repo is open
    const spawn = spawnPill(page)
    await expect(spawn).toHaveAttribute('aria-disabled', 'true')
    await expect(spawn).toHaveAttribute('data-tip', 'Open a repository first')
    await spawn.click({ force: true }) // aria-disabled: the click does nothing
    await expect(page.getByRole('dialog', { name: 'Spawn agents' })).toHaveCount(0)

    await openRepo(page)
    await expect(spawn).toHaveAttribute('aria-disabled', 'false')

    // the popover closes with Esc and gives the focus back
    await spawn.click()
    const dlg = page.getByRole('dialog', { name: 'Spawn agents' })
    await expect(dlg.getByLabel('Preset')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
    await expect(spawn).toBeFocused()

    await spawnAgent(page, 'builder', 'opus', 1)
    await spawnAgent(page, 'builder', 'sonnet', 2)
    const cards = page.getByTestId('agent-node')
    for (const i of [0, 1]) await expect(cards.nth(i).getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    // the header only carries name, role tag and status; model and branch live in the details popover
    await expect(cards.nth(0)).not.toContainText(/agent\/builder|opus|sonnet/)
    const [n0, n1] = await Promise.all([0, 1].map((i) => cards.nth(i).getAttribute('data-name')))
    expect(n0).toMatch(/^[A-Z][a-z]{1,4}$/)
    expect(n1).toMatch(/^[A-Z][a-z]{1,4}$/)
    expect(n1!.toLowerCase()).not.toBe(n0!.toLowerCase())

    // two worktrees, two branches, expected argv, no dangerous flag, no parent-session env
    await expect.poll(() => r.runs().length).toBe(2)
    const runs = r.runs().sort((a, b) => a.cwd.localeCompare(b.cwd))
    const wtBase = realpathSync(join(tmp, 'userdata', 'worktrees'))
    expect(runs.map((x) => basename(x.cwd))).toEqual(['builder-1', 'builder-2'])
    for (const run of runs) {
      expect(run.cwd.startsWith(wtBase + '/')).toBe(true)
      expect(run.argv.join(' ')).not.toMatch(/dangerously|skip-permissions/)
      expect(run.claudeEnv.filter((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_'))).toEqual([])
    }
    const settingsArg = expect.stringMatching(/^--settings=\/.+\/agents\/[0-9a-f-]{36}\/settings\.json$/)
    const mcpArg = expect.stringMatching(/^--mcp-config=\/.+\/agents\/[0-9a-f-]{36}\/mcp\.json$/)
    expect(runs[0]!.argv).toEqual(['--model=opus', mcpArg, settingsArg, expect.stringMatching(/^--session-id=[0-9a-f-]{36}$/)])
    expect(runs[1]!.argv).toEqual(['--model=sonnet', mcpArg, settingsArg, expect.stringMatching(/^--session-id=[0-9a-f-]{36}$/)])
    expect(runs[0]!.argv[3]).not.toBe(runs[1]!.argv[3])
    for (const run of runs) for (const i of [1, 2]) expect(run.argv[i]!.split('=')[1]!.startsWith(`${realpathSync(join(tmp, 'userdata'))}/`)).toBe(true) // outside any worktree
    expect(r.agentBranches().sort()).toEqual(['agent/builder-1', 'agent/builder-2'])
    expect(r.worktreeCount()).toBe(3)

    // three-line prompt through the Prompt box: one submission, newlines inside the paste markers
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'idle') // prompts wait for the session to be ready
    await cards.nth(0).getByRole('button', { name: n0!, exact: true }).click()
    const box = page.getByRole('textbox', { name: `Prompt for ${n0}` })
    await expect(box).toBeFocused()
    await box.fill('line one\nline two\nline three')
    await box.press('Control+Enter')
    await expect(page.getByRole('dialog', { name: `Details for ${n0}` })).toHaveCount(0) // sending closes the popover
    await expect(cards.nth(0).getByTestId('terminal-body')).toContainText('SUBMITTED 1')
    await page.waitForTimeout(500)
    const pid0 = runs[0]!.pid
    const subs = readFileSync(join(r.logs, `${pid0}.subs`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string)
    expect(subs).toEqual([`${START}line one\nline two\nline three${END}`])
    expect(readFileSync(join(r.logs, `${pid0}.stdin`), 'latin1')).toBe(`${START}line one\nline two\nline three${END}\r`)
    expect(existsSync(join(r.logs, `${runs[1]!.pid}.stdin`))).toBe(false)

    // close both: no process, no worktree directory, no agent/* branch
    await page.getByRole('button', { name: `Close ${n0}` }).click()
    await page.getByRole('button', { name: `Close ${n1}` }).click()
    await expect(cards).toHaveCount(0)
    await expectGone(...runs.map((x) => x.pid))
    await expect.poll(() => runs.some((x) => existsSync(x.cwd))).toBe(false)
    await expect.poll(() => r.agentBranches()).toEqual([])
    expect(r.worktreeCount()).toBe(1)
    await expect(page.locator('p[role=status]')).toHaveCount(0) // nothing kept or archived, so no notice

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('quitting with an agent open leaves no process and keeps its worktree for the saved board', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  let closed = false
  try {
    await openRepo(page)
    await spawnAgent(page, 'solo', 'haiku', 1)
    await expect.poll(() => r.runs().length).toBe(1)
    const [run] = r.runs()
    expect(errors).toEqual([])
    await app.close()
    closed = true
    await expectGone(run!.pid)
    // F8: the worktree and its branch stay, so the agent can be resumed in it when the project opens again
    expect(existsSync(run!.cwd)).toBe(true)
    expect(r.agentBranches()).toEqual(['agent/solo-1'])
  } finally {
    if (!closed) await app.close()
  }
})

/** Writes one line to the hook socket the way an attacker without the right token would. */
function sendRaw(socket: string, data: string): Promise<void> {
  return new Promise((done) => {
    const s = connect(socket)
    s.on('error', () => done())
    s.on('close', () => done())
    s.end(data)
  })
}

test('live status from hooks, Last message, live badge, token check, prompt gating, settings cleanup', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, FAKE_TRUST_GATE: '1' })
  let closed = false
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __states: string[] }
      w.__states = []
      window.api.on('agent:state', (p) => w.__states.push(`${p.id.slice(0, 8)}:${p.state}`))
    })
    const states = async (id: string) =>
      (await page.evaluate(() => (window as unknown as { __states: string[] }).__states)).filter((s) => s.startsWith(id.slice(0, 8))).map((s) => s.split(':')[1])
    const badge = page.getByTestId('live-badge')
    await expect(badge).toHaveText(/^0 live/)
    await openRepo(page)

    // 1. spawned: starting, waiting for the (fake) trust dialog; prompts refused in the UI and in main
    await spawnAgent(page, 'builder', 'haiku', 1)
    const card = page.getByTestId('agent-node').nth(0)
    const n0 = (await card.getAttribute('data-name'))!
    await expect(card).toHaveAttribute('data-state', 'starting')
    await expect(card.getByTestId('status-word')).toHaveText('starting')
    await expect(badge).toHaveText(/^1 live/)
    const id = (await page.locator('.react-flow__node', { has: page.getByTestId('agent-node') }).nth(0).getAttribute('data-id'))!
    const nameBtn = card.getByRole('button', { name: n0, exact: true })
    await nameBtn.click()
    const details = page.getByRole('dialog', { name: `Details for ${n0}` })
    await expect(details.getByRole('textbox', { name: `Prompt for ${n0}` })).toBeDisabled()
    await expect(details.getByTestId('prompt-hint')).toHaveText('Answer the dialog in the terminal first')
    await expect(details.getByRole('button', { name: 'Send' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(nameBtn).toBeFocused()
    const refused = await page.evaluate((agentId) => window.api.invoke('agent:prompt', { id: agentId, text: 'hi' }).then(() => 'sent', (e: Error) => e.message), id)
    expect(refused).toContain('Agent is still starting; answer its terminal first')
    await expect.poll(() => r.runs().length).toBe(1)
    const [run] = r.runs()
    expect(existsSync(join(r.logs, `${run!.pid}.stdin`))).toBe(false) // not even an Enter reached the dialog
    const settingsPath = run!.argv.find((a) => a.startsWith('--settings='))!.slice('--settings='.length)
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(settingsPath)).mode & 0o777).toBe(0o700)
    expect(statSync(run!.hookSocket).mode & 0o777).toBe(0o600)

    // 2. the user answers the dialog in the terminal: SessionStart -> idle
    await card.getByTestId('terminal-body').click()
    await page.keyboard.type('y')
    await expect(card).toHaveAttribute('data-state', 'idle')

    // 3. forged events on the real socket: no token, wrong token -> nothing changes
    const forged = { hook_event_name: 'UserPromptSubmit', session_id: '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11' }
    await sendRaw(run!.hookSocket, JSON.stringify({ event: forged }) + '\n')
    await sendRaw(run!.hookSocket, JSON.stringify({ token: 'f'.repeat(64), event: forged }) + '\n')
    await sendRaw(run!.hookSocket, JSON.stringify({ token: 'f'.repeat(64), agentId: id, event: forged }) + '\n')
    await page.waitForTimeout(500)
    await expect(card).toHaveAttribute('data-state', 'idle')
    expect(await states(id)).toEqual(['idle'])

    // 4. one turn with a permission request: the card changes state by itself
    await nameBtn.click()
    const box = page.getByRole('textbox', { name: `Prompt for ${n0}` })
    await box.fill('Please PERMISSION run ls\nsecond line')
    await box.press('Control+Enter')
    await expect(card).toHaveAttribute('data-state', 'working')
    await expect(card.getByTestId('status-word')).toHaveText('running')
    await expect(card).toHaveAttribute('data-state', 'waiting')
    await expect(card.getByTestId('status-word')).toHaveText('needs you')
    await expect(card).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    expect(await states(id)).toEqual(['idle', 'working', 'waiting', 'working', 'idle'])

    // 5. Last: the transcript's last assistant text (not the sidechain), keyboard operable
    await nameBtn.click()
    const dlg = page.getByRole('dialog', { name: `Details for ${n0}` })
    await expect(dlg.getByTestId('last-source')).toHaveAttribute('data-source', 'transcript')
    await expect(dlg.getByTestId('last-text')).toHaveText('FINAL ANSWER to Please PERMISSION run ls')
    await expect(dlg.getByRole('textbox', { name: `Prompt for ${n0}` })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
    await expect(nameBtn).toBeFocused()

    // 5b. an interrupted turn has no Stop: the idle_prompt notification brings the card back to idle
    await nameBtn.click()
    await box.fill('IDLEPROMPT then Esc')
    await box.press('Control+Enter')
    await expect(card).toHaveAttribute('data-state', 'working')
    await expect(card).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    expect(await states(id)).toEqual(['idle', 'working', 'waiting', 'working', 'idle', 'working', 'idle'])

    // 6. a second agent with no transcript: best-effort scrape of its terminal
    await spawnAgent(page, 'builder', 'haiku', 2)
    const card2 = page.getByTestId('agent-node').nth(1)
    const n1 = (await card2.getAttribute('data-name'))!
    await expect(badge).toHaveText(/^2 live/)
    await card2.getByTestId('terminal-body').click()
    await page.keyboard.type('y')
    await expect(card2).toHaveAttribute('data-state', 'idle')
    await card2.getByRole('button', { name: n1, exact: true }).click()
    await page.getByRole('textbox', { name: `Prompt for ${n1}` }).fill('NOTRANSCRIPT please')
    await page.getByRole('textbox', { name: `Prompt for ${n1}` }).press('Control+Enter')
    await expect(card2.getByTestId('terminal-body')).toContainText('ANSWER: FINAL ANSWER to NOTRANSCRIPT please')
    await expect(card2).toHaveAttribute('data-state', 'idle')
    await card2.getByRole('button', { name: n1, exact: true }).click()
    const dlg2 = page.getByRole('dialog', { name: `Details for ${n1}` })
    await expect(dlg2.getByTestId('last-source')).toHaveAttribute('data-source', 'scrape')
    await expect(dlg2.getByTestId('last-source')).toContainText('Best effort · scraped from the terminal')
    await expect(dlg2.getByTestId('last-text')).toContainText('ANSWER: FINAL ANSWER to NOTRANSCRIPT please')
    expect(await dlg2.getByTestId('last-text').textContent()).not.toContain(String.fromCharCode(27))
    await page.keyboard.press('Escape')

    // 7. closing deletes the settings file and updates the badge
    await page.getByRole('button', { name: `Close ${n0}` }).click()
    await expect(badge).toHaveText(/^1 live/)
    await expect.poll(() => existsSync(dirname(settingsPath))).toBe(false)
    await page.getByRole('button', { name: `Close ${n1}` }).click()
    await expect(badge).toHaveText(/^0 live/)
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expectGone(...r.runs().map((x) => x.pid))
    await expect.poll(() => r.agentBranches()).toEqual([])

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
    await app.close()
    closed = true
    expect(existsSync(dirname(run!.hookSocket))).toBe(false) // socket dir removed on quit
  } finally {
    if (!closed) await app.close()
  }
})

import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { cleanupTemp, expectGone, launch, newConsole, typeIn } from './helpers'
import { END, openRepo, setupRepo, spawnPreset, START, submissions } from './repo'

test.afterEach(cleanupTemp)

const box = async (l: Locator) => (await l.boundingBox())!
const card = (page: Page, name: string) => page.locator(`[data-testid=agent-node][data-name="${name}"]`)
const edges = (page: Page) => page.locator('.react-flow__edge-flow')

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

async function createSquad(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Presets', exact: true }).click()
  await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
}

/** Short names of the agents with that role, in board order. */
const namesOf = (page: Page, role: string) =>
  page.locator('[data-testid=agent-node]').evaluateAll((els, role) => els.filter((e) => e.querySelector('[data-testid=role-tag]')?.textContent === role).map((e) => e.getAttribute('data-name')!), role)

/** Types a prompt into the agent's terminal, as the user would. */
async function prompt(page: Page, name: string, text: string): Promise<void> {
  await card(page, name).getByTestId('terminal-body').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const procState = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  } catch {
    return 'gone'
  }
}

test('squad edges are real: a member\'s reply reaches the Orchestrator and the edge runs; the editor works by keyboard; Connect re-links', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await createSquad(page)
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 60_000 })
    await expect(edges(page)).toHaveCount(4)
    for (const name of ['FRONTEND', 'BACKEND', 'TESTERS', 'REVIEWERS']) await expect(page.getByRole('button', { name: `Edge ${name} to Orchestrator` })).toBeVisible()
    // every agent got an MCP config of its own, outside the repository and its worktrees
    const configs = r.runs().map((x) => x.argv.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length) ?? '')
    expect(new Set(configs).size).toBe(9)
    for (const c of configs) expect(c.includes(r.repo) || c.includes('worktrees')).toBe(false)

    // a frontend member ends a turn: its reply goes through the FRONTEND edge into the Orchestrator, and the edge runs meanwhile
    const lead = r.runs().find((x) => x.cwd.endsWith('orchestrator-1'))!
    const fe = await namesOf(page, 'frontend')
    await prompt(page, fe[0]!, 'build the page')
    await expect(page.locator('[data-testid=flow-edge][data-state=firing]')).toHaveCount(1, { timeout: 10_000 })
    await page.screenshot({ path: test.info().outputPath('f5.png') })
    await expect.poll(() => submissions(r.logs, lead.pid), { timeout: 10_000 }).toEqual([`${START}From ${fe[0]} (frontend):\nFINAL ANSWER to build the page${END}`])
    await expect(page.locator('[data-testid=flow-edge][data-state=firing]')).toHaveCount(0, { timeout: 5000 })

    // the edge editor, by keyboard only: Enter opens it on the dot, Esc closes it and gives the focus back
    const dot = page.getByRole('button', { name: 'Edge FRONTEND to Orchestrator' })
    const editor = page.getByRole('dialog', { name: 'Edge FRONTEND to Orchestrator' })
    await dot.focus()
    await page.keyboard.press('Enter')
    const tpl = editor.getByRole('textbox', { name: 'Template' })
    await expect(tpl).toBeFocused()
    await expect(tpl).toHaveValue('From {name} ({role}):\n{message}')
    await expect(editor.getByTestId('edge-status')).toHaveText('Active')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('FE {name} says {message}')
    await page.keyboard.press('Tab')
    await expect(editor.getByRole('textbox', { name: 'Only when the reply contains' })).toBeFocused()
    await page.keyboard.type('ANSWER')
    for (const name of ['Remove', 'Pause', 'Save']) {
      await page.keyboard.press('Tab')
      await expect(editor.getByRole('button', { name })).toBeFocused()
    }
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect(dot).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(tpl).toHaveValue('FE {name} says {message}')
    await expect(editor.getByRole('textbox', { name: 'Only when the reply contains' })).toHaveValue('ANSWER')
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(dot).toBeFocused()

    // the condition holds back a reply without the text; the new template shapes the one with it
    await prompt(page, fe[1]!, 'REPLY:nothing to report')
    await expect(card(page, fe[1]!).getByTestId('terminal-body')).toContainText('ANSWER: nothing to report', { timeout: 10_000 })
    await page.waitForTimeout(800)
    expect(submissions(r.logs, lead.pid)).toHaveLength(1)
    await prompt(page, fe[1]!, 'REPLY:the answer is 42')
    await expect.poll(() => submissions(r.logs, lead.pid).at(-1), { timeout: 10_000 }).toBe(`${START}FE ${fe[1]} says the answer is 42${END}`)

    // Connect re-creates a removed squad edge and lights all four; with nothing missing it only lights them
    await page.getByRole('button', { name: 'Edge TESTERS to Orchestrator' }).click()
    await page.getByRole('dialog', { name: 'Edge TESTERS to Orchestrator' }).getByRole('button', { name: 'Remove' }).click()
    await expect(edges(page)).toHaveCount(3)
    const connectBtn = page.getByTestId('orchestrator-node').getByRole('button', { name: 'Connect' })
    await connectBtn.click()
    await expect(edges(page)).toHaveCount(4)
    await expect(page.getByRole('button', { name: 'Edge TESTERS to Orchestrator' })).toBeVisible()
    await expect(page.locator('[data-testid=flow-edge][data-lit]')).toHaveCount(4)
    await expect(page.locator('[data-testid=flow-edge][data-lit]')).toHaveCount(0, { timeout: 5000 })
    await connectBtn.click()
    await expect(page.locator('[data-testid=flow-edge][data-lit]')).toHaveCount(4)
    await expect(edges(page)).toHaveCount(4)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('a loop A -> B -> A pauses its edge by itself and says so', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(2, { timeout: 30_000 })
    const [a, b] = (await namesOf(page, 'frontend')) as [string, string]

    // A -> B: drag from A's side handle onto B's card
    await card(page, a).hover()
    const handle = page.locator(`.react-flow__node[data-id="${await card(page, a).evaluate((el) => el.closest('.react-flow__node')!.getAttribute('data-id'))}"] > .flow-handle[data-handleid="r"]`)
    await expect(handle).toHaveCSS('opacity', '1')
    const h = await box(handle)
    const target = await box(card(page, b).getByTestId('terminal-body'))
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(edges(page)).toHaveCount(1)
    await expect(page.getByRole('button', { name: `Edge ${a} to ${b}` })).toBeVisible()

    // B -> A: from B's details, the keyboard way
    await card(page, b).getByRole('button', { name: b, exact: true }).click()
    const details = page.getByRole('dialog', { name: `Details for ${b}` })
    await details.getByLabel('Connect to…').selectOption({ label: `${a} (frontend)` })
    await details.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(edges(page)).toHaveCount(2)
    await page.keyboard.press('Escape')

    await prompt(page, a, 'ping')
    await expect(page.getByRole('alert')).toHaveText(`Edge ${a} to ${b} paused. Loop detected, this edge fired 3 times in one chain.`, { timeout: 30_000 })
    await expect(page.getByRole('button', { name: `Edge ${a} to ${b}, paused` })).toBeVisible()
    await expect(page.locator('[data-testid=flow-edge][data-state=paused]')).toHaveCount(1)
    // A -> B fired twice, B -> A twice; the third A -> B was held back
    const run = (n: string) => r.runs().find((x) => submissions(r.logs, x.pid).some((s) => s.includes(n)))!
    const runA = run('ping')
    const runB = r.runs().find((x) => x.pid !== runA.pid)!
    expect(submissions(r.logs, runB.pid)).toHaveLength(2)
    await expect.poll(() => submissions(r.logs, runA.pid)).toHaveLength(3)
    await page.waitForTimeout(2500)
    expect(submissions(r.logs, runB.pid)).toHaveLength(2)
    // the editor shows why and resumes it
    await page.getByRole('button', { name: `Edge ${a} to ${b}, paused` }).click()
    const editor = page.getByRole('dialog', { name: `Edge ${a} to ${b}` })
    await expect(editor.getByTestId('edge-status')).toHaveText('Paused · Loop detected, this edge fired 3 times in one chain')
    await editor.getByRole('button', { name: 'Resume' }).click()
    await expect(editor.getByTestId('edge-status')).toHaveText('Active')
    await expect(page.locator('[data-testid=flow-edge][data-state=paused]')).toHaveCount(0)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('Pause all freezes every process and flow; Resume all brings them back; closing while paused leaves no process', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    const pause = page.getByRole('button', { name: 'Pause all', exact: true })
    const resume = page.getByRole('button', { name: 'Resume all', exact: true })
    await expect(pause).toHaveAttribute('aria-disabled', 'true') // nothing runs yet
    await newConsole(page, 1)
    const con = page.getByTestId('terminal-node')
    await typeIn(page, 0, 'echo PID=$$; i=0; while true; do echo tick$i; i=$((i+1)); sleep 0.2; done')
    await expect(con.getByTestId('terminal-body')).toContainText('tick3')
    const shellPid = Number(/PID=(\d+)/.exec((await con.getByTestId('terminal-body').textContent()) ?? '')![1])
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 1)
    const agent = page.getByTestId('agent-node')
    await expect(agent).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
    const agentPid = r.runs()[0]!.pid
    const name = (await agent.getAttribute('data-name'))!
    const rows = () => con.locator('.xterm-rows').textContent()

    await expect(resume).toHaveAttribute('aria-disabled', 'true')
    await expect(resume).toHaveAttribute('data-tip', 'Nothing is paused')
    await pause.click()
    await expect(agent.getByTestId('status-word')).toHaveText('paused')
    await expect(con.getByTestId('status-word')).toHaveText('paused')
    await expect(pause).toHaveAttribute('aria-disabled', 'true')
    await expect(resume).not.toHaveAttribute('aria-disabled')
    await expect(page.getByRole('button', { name: 'New console', exact: true })).toHaveAttribute('data-tip', 'Everything is paused, resume all first')
    await expect.poll(() => [procState(agentPid), procState(shellPid)]).toEqual(['T', 'T'])
    const frozen = await rows()
    await page.waitForTimeout(1200)
    expect(await rows()).toBe(frozen) // the loop that printed every 0.2 s prints nothing
    // nothing new starts while paused
    expect(await page.evaluate(() => window.api.invoke('pty:spawn', { cols: 80, rows: 24 }).then(() => 'started', (e: Error) => e.message))).toMatch(/Everything is paused, resume all first/)

    await resume.click()
    await expect(agent.getByTestId('status-word')).toHaveText('resting') // back to its state before the pause
    await expect(con.getByTestId('status-word')).toHaveText('running')
    await expect.poll(rows).not.toBe(frozen)
    expect([procState(agentPid), procState(shellPid)]).not.toContain('T')
    await expect(resume).toHaveAttribute('aria-disabled', 'true')

    // paused again, then closed: continued before the hangup, so no stopped process stays behind
    await pause.click()
    await expect(agent.getByTestId('status-word')).toHaveText('paused')
    await page.getByRole('button', { name: `Close ${name}` }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expectGone(agentPid)
    await con.getByRole('button', { name: /^Close console/ }).click()
    await expect(con).toHaveCount(0)
    await expectGone(shellPid)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('MCP: no or a wrong token is rejected; with its token an agent lists, messages and reports end to end', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(2, { timeout: 30_000 })
    const [a, b] = (await namesOf(page, 'frontend')) as [string, string]

    // the bridge itself: a 0600 config outside the repository; the socket refuses anything without the agent's token
    const cfgPath = r.runs()[0]!.argv.find((x) => x.startsWith('--mcp-config='))!.slice('--mcp-config='.length)
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
    expect(cfgPath.startsWith(r.repo)).toBe(false)
    const server = (JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers['nodshell']!
    const ask = (payload: unknown) =>
      new Promise<{ result?: { tools?: { name: string }[] }; error?: { code: number } }>((done, fail) => {
        const s = connect(server.env['NODSHELL_MCP_SOCKET']!)
        let buf = ''
        s.on('data', (c) => {
          buf += c.toString()
          if (!buf.includes('\n')) return
          s.destroy()
          done(JSON.parse(buf.split('\n')[0]!))
        })
        s.on('error', fail)
        s.write(JSON.stringify(payload) + '\n')
      })
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { to: b, text: 'sneaky' } } }
    expect(await ask({ message: call })).toMatchObject({ error: { code: -32001 } })
    expect(await ask({ token: 'f'.repeat(64), message: call })).toMatchObject({ error: { code: -32001 } })
    expect(await ask({ token: server.env['NODSHELL_MCP_TOKEN'], message: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).toMatchObject({ result: { tools: [{ name: 'list_agents' }, { name: 'send_message' }, { name: 'read_last_message' }, { name: 'report_status' }, { name: 'memory_read' }, { name: 'memory_write' }] } })
    await page.waitForTimeout(300)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([]) // nothing reached any agent

    // through the relay, as Claude Code runs it
    const mcpLog = (pid: number) => {
      try {
        return readFileSync(join(r.logs, `${pid}.mcp`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { result?: { content: { text: string }[]; isError: boolean } })
      } catch {
        return []
      }
    }
    await prompt(page, a, 'MCPCALL list_agents {}')
    await expect.poll(() => r.runs().some((x) => mcpLog(x.pid).length > 0), { timeout: 10_000 }).toBe(true)
    const runA = r.runs().find((x) => mcpLog(x.pid).length > 0)!
    const runB = r.runs().find((x) => x.pid !== runA.pid)!
    const listed = JSON.parse(mcpLog(runA.pid)[0]!.result!.content[0]!.text) as { name: string; you?: boolean; state: string }[]
    expect(listed.map((x) => x.name).sort()).toEqual([a, b].sort())
    expect(listed.find((x) => x.name === a)).toMatchObject({ you: true })

    await prompt(page, a, `MCPCALL send_message {"to":"${b.toLowerCase()}","text":"hello from mcp"}`)
    await expect.poll(() => submissions(r.logs, runB.pid), { timeout: 10_000 }).toEqual([`${START}From ${a} (frontend):\nhello from mcp${END}`])
    await expect.poll(() => mcpLog(runA.pid)[1]?.result).toEqual({ content: [{ type: 'text', text: `Sent to ${b}` }], isError: false })
    await expect(card(page, a).getByTestId('terminal-body')).toContainText(`MCP RESULT Sent to ${b}`)

    // B on a permission prompt: nothing is typed into it; the message waits and arrives once its turn ends
    await expect(card(page, b)).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await prompt(page, b, 'PERMISSION wait')
    await expect(card(page, b)).toHaveAttribute('data-state', /working|waiting/)
    await prompt(page, a, `MCPCALL send_message {"to":"${b}","text":"while you were busy"}`)
    await expect.poll(() => mcpLog(runA.pid)[2]?.result, { timeout: 10_000 }).toEqual({ content: [{ type: 'text', text: `Queued for ${b}, delivered when their turn ends` }], isError: false })
    await expect.poll(() => submissions(r.logs, runB.pid), { timeout: 15_000 }).toEqual([`${START}From ${a} (frontend):\nhello from mcp${END}`, 'PERMISSION wait', `${START}From ${a} (frontend):\nwhile you were busy${END}`])

    await prompt(page, a, 'MCPCALL report_status {"text":"halfway there"}')
    await expect.poll(() => mcpLog(runA.pid)[3]?.result?.content[0]?.text).toBe('Status reported')
    await card(page, a).getByRole('button', { name: a, exact: true }).click()
    await expect(page.getByRole('dialog', { name: `Details for ${a}` }).getByTestId('agent-report')).toHaveText('halfway there')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

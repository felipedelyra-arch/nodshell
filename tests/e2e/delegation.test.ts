import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanupTemp, launch } from './helpers'
import { END, openRepo, setupRepo, START, submissions } from './repo'

test.afterEach(cleanupTemp)

type McpReply = { result?: { content: { text: string }[]; isError: boolean } }
const mcpLog = (logs: string, pid: number): McpReply[] => {
  try {
    return readFileSync(join(logs, `${pid}.mcp`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as McpReply)
  } catch {
    return []
  }
}
const card = (page: Page, name: string) => page.locator(`[data-testid=agent-node][data-name="${name}"]`)

async function squad(page: Page): Promise<void> {
  await openRepo(page)
  await page.getByRole('button', { name: 'Presets', exact: true }).click()
  await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
  await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 60_000 })
}

/** Opens the Orchestrator's terminal, types a prompt as the user would, waits for its submission and restores the board. */
async function tellOrchestrator(page: Page, text: string, n: number): Promise<string> {
  const lead = page.getByTestId('agent-node').filter({ has: page.getByTestId('role-tag').filter({ hasText: /^orchestrator$/ }) })
  const name = (await lead.getAttribute('data-name'))!
  await page.getByTestId('orchestrator-node').getByRole('button', { name: /^Open Orchestrator terminal/ }).click()
  await lead.getByTestId('terminal-body').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await expect(lead.getByTestId('terminal-body')).toContainText(`SUBMITTED ${n}`)
  await lead.getByRole('button', { name: `Restore ${name}` }).click()
  await expect(lead).toBeHidden()
  return name
}

test('a goal typed into the Orchestrator makes it delegate to its squad: the counter goes from 0/0 through running to 2/2', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await squad(page)
    const counter = page.getByTestId('orchestrator-node').getByTestId('orch-tasks')
    await expect(counter).toHaveText('0/0')
    await expect(counter).toHaveAttribute('aria-label', '0 of 0 tasks done')
    await expect(counter).toHaveAttribute('title', 'No tasks yet')

    const lead = await tellOrchestrator(page, 'GOAL:SLOW build the page', 1)
    // two tasks, each running from its delivery while its member works
    await expect(counter).toHaveText('0/2', { timeout: 20_000 })
    await expect(counter).toHaveAttribute('aria-label', '0 of 2 tasks done')
    await expect(counter).toHaveAttribute('title', /^Latest tasks\nrunning · \w+ · SLOW build the page part 2\nrunning · \w+ · SLOW build the page part 1$/)
    await page.screenshot({ path: test.info().outputPath('f6.png') })
    // the members got one prompt each, from the Orchestrator
    const fe = r.runs().filter((x) => /frontend-[12]$/.test(x.cwd))
    expect(fe).toHaveLength(2)
    const got = fe.map((x) => submissions(r.logs, x.pid)).sort()
    expect(got).toEqual([[`${START}From ${lead} (orchestrator):\nSLOW build the page part 1${END}`], [`${START}From ${lead} (orchestrator):\nSLOW build the page part 2${END}`]])
    // done once each has ended the turn the task started
    await expect(counter).toHaveText('2/2', { timeout: 20_000 })
    await expect(counter).toHaveAttribute('aria-label', '2 of 2 tasks done')
    await expect(counter).toHaveAttribute('title', /done · \w+ · SLOW build the page part 2\ndone · \w+ · SLOW build the page part 1$/)
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('spawn_agent: approved, the agent joins its group and gets the task; denied, nothing starts; at the process limit it is refused', async () => {
  test.setTimeout(240_000)
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_SPAWN: 'yes,no,yes' })
  try {
    await squad(page)
    const orch = page.getByTestId('orchestrator-node')
    const leadRun = r.runs().find((x) => x.cwd.endsWith('orchestrator-1'))!
    const result = (i: number) => mcpLog(r.logs, leadRun.pid)[i]?.result

    // approved (scripted "yes"): a third Backend member, in the Backend frame, listed by the Orchestrator
    const lead = await tellOrchestrator(page, 'MCPCALL spawn_agent {"preset":"backend","task":"REPLY:api ready\\nwrite the API"}', 1)
    await expect.poll(() => result(0)?.isError, { timeout: 20_000 }).toBe(false)
    const name = /^Started (\w+) \(Backend\) in group Backend\./.exec(result(0)!.content[0]!.text)?.[1]
    expect(name).toBeTruthy()
    await expect(page.getByTestId('agent-node')).toHaveCount(10)
    const backend = page.locator('[data-testid=group-node][data-name="Backend"]')
    await expect(backend.getByTestId('group-label')).toHaveText('BACKEND 3 · 3 running')
    await expect(orch.getByTestId('orch-section').filter({ hasText: 'BACKEND' })).toHaveText(new RegExp(`^BACKEND\\s*3.*${name}`))
    const frame = (await backend.locator('.group-frame').boundingBox())!
    const box = (await card(page, name!).boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(frame.x)
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1)
    const peer = (await page.getByTestId('agent-node').filter({ has: page.getByTestId('role-tag').filter({ hasText: /^backend$/ }) }).first().boundingBox())!
    expect(box.y).toBe(peer.y) // the same single row
    expect(box.x).toBeGreaterThan(peer.x)
    const run = r.runs().find((x) => x.cwd.endsWith('backend-3'))!
    expect(run.argv.join(' ')).not.toContain('dangerously')
    // its task goes as its first prompt once it is resting, and counts as a squad task
    await expect.poll(() => submissions(r.logs, run.pid), { timeout: 20_000 }).toEqual([`${START}From ${lead} (orchestrator):\nREPLY:api ready\nwrite the API${END}`])
    await expect(orch.getByTestId('orch-tasks')).toHaveText('1/1', { timeout: 20_000 })

    // denied (scripted "no"): an error for the agent, nothing created
    await tellOrchestrator(page, 'MCPCALL spawn_agent {"preset":"Frontend","task":"never"}', 2)
    await expect.poll(() => result(1), { timeout: 20_000 }).toEqual({ content: [{ type: 'text', text: 'The user denied the request, nothing was started' }], isError: true })
    await expect(page.getByTestId('agent-node')).toHaveCount(10)
    expect(r.runs()).toHaveLength(10)
    expect(r.agentBranches()).toHaveLength(10)

    // the board full (10 agents + 10 consoles = 20): refused before asking, so the scripted "yes" is never used
    for (let i = 1; i <= 10; i++) {
      await page.getByRole('button', { name: 'New console', exact: true }).click()
      await expect(page.getByTestId('terminal-node')).toHaveCount(i)
    }
    await tellOrchestrator(page, 'MCPCALL spawn_agent {"preset":"Reviewers","task":"one too many"}', 3)
    await expect.poll(() => result(2), { timeout: 20_000 }).toEqual({ content: [{ type: 'text', text: 'Only 0 of 20 terminals are free, cannot start 1' }], isError: true })
    await page.waitForTimeout(500)
    await expect(page.getByTestId('agent-node')).toHaveCount(10)
    await expect(page.getByTestId('terminal-node')).toHaveCount(10)
    expect(r.runs()).toHaveLength(10)
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

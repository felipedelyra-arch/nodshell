import { expect, test, type Page } from '@playwright/test'
import { cleanupTemp, launch } from './helpers'
import { END, openRepo, setupRepo, spawnPreset, START, submissions } from './repo'

test.afterEach(cleanupTemp)

const card = (page: Page, name: string) => page.locator(`[data-testid=agent-node][data-name="${name}"]`)

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

/** Two Frontend agents, resting: their names (A first) and the fake CLI run of each. */
async function twoAgents(page: Page, r: ReturnType<typeof setupRepo>) {
  await openRepo(page)
  await spawnPreset(page, 'Frontend', 2)
  await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(2, { timeout: 30_000 })
  const names = await page.getByTestId('agent-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')!))
  const [a, b] = names as [string, string]
  const branchOf = async (n: string) => {
    await card(page, n).getByRole('button', { name: n, exact: true }).click()
    const branch = (await page.getByRole('dialog', { name: `Details for ${n}` }).locator('dd').nth(2).textContent())!
    await page.keyboard.press('Escape')
    return branch
  }
  const runs = r.runs()
  const runOf = (branch: string) => runs.find((x) => x.cwd.endsWith(`/${branch.replace('agent/', '')}`))!
  const aBranch = await branchOf(a)
  const bBranch = await branchOf(b)
  return { a, b, aBranch, runA: runOf(aBranch), runB: runOf(bBranch) }
}

/** A's details: pick B and hand off; returns the details dialog. */
async function handOff(page: Page, a: string, b: string) {
  await card(page, a).getByRole('button', { name: a, exact: true }).click()
  const details = page.getByRole('dialog', { name: `Details for ${a}` })
  await details.getByLabel('Hand off to').selectOption({ label: b })
  await details.getByRole('button', { name: 'Hand off', exact: true }).click()
  return details
}

const nodeId = (page: Page, name: string) => page.locator('.react-flow__node', { has: card(page, name) }).getAttribute('data-id')

test('acceptance: A writes its briefing, the user edits it, Send gives B ONE prompt with the header and the briefing (an edge A -> B never passes it on)', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    const { a, b, aBranch, runA, runB } = await twoAgents(page, r)
    // an active edge A -> B (set up through the real channel): any other Stop of A would pass its reply to B
    const [idA, idB] = [await nodeId(page, a), await nodeId(page, b)]
    await page.evaluate(([s, t]) => window.api.invoke('flow:create', { source: { kind: 'agent', id: s! }, target: { kind: 'agent', id: t! } }), [idA, idB])
    await handOff(page, a, b)
    // A got the fixed request as one paste + Enter (its first line is what the fake CLI echoes back as the answer)
    await expect.poll(() => submissions(r.logs, runA.pid).length, { timeout: 10_000 }).toBe(1)
    const request = submissions(r.logs, runA.pid)[0]!.split(START).join('').split(END).join('')
    expect(request).toMatch(/^Another agent is taking over your work\. Write a handoff briefing/)
    const dlg = page.getByRole('dialog', { name: `Hand off ${a} → ${b}` })
    await expect(dlg).toBeVisible({ timeout: 15_000 })
    const text = dlg.getByTestId('handoff-text')
    await expect(text).toHaveValue(`FINAL ANSWER to ${request}`)
    await page.waitForTimeout(1500) // the edge would have fired by now
    expect(submissions(r.logs, runB.pid)).toEqual([]) // nothing reached B yet, not even through the edge
    const briefing = 'Built the landing page.\nNext: write its tests.'
    await text.fill(briefing)
    await expect(dlg.getByTestId('handoff-size')).toHaveText(`${briefing.length} / 19800 characters`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: test.info().outputPath('f14.png') })
    await dlg.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByText(`Handoff sent to ${b}.`)).toBeVisible()
    await expect.poll(() => submissions(r.logs, runB.pid), { timeout: 10_000 }).toEqual([`${START}Handoff from ${a} (frontend, branch ${aBranch})\n\n${briefing}${END}`])
    await page.waitForTimeout(1500)
    expect(submissions(r.logs, runB.pid)).toHaveLength(1)
    expect(submissions(r.logs, runA.pid)).toHaveLength(1) // the source is neither closed nor prompted again
    // the edge is live: A's next turn (a prompt of the user's) passes its reply on to B as usual
    await expect(card(page, b)).toHaveAttribute('data-state', 'idle', { timeout: 15_000 })
    const details = page.getByRole('dialog', { name: `Details for ${a}` })
    if (!(await details.isVisible())) await card(page, a).getByRole('button', { name: a, exact: true }).click()
    await details.getByLabel(`Prompt for ${a}`).fill('REPLY:after the handoff')
    await details.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => submissions(r.logs, runB.pid).length, { timeout: 15_000 }).toBe(2)
    expect(submissions(r.logs, runB.pid)[1]).toContain('after the handoff')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('Cancel discards the briefing: B gets nothing', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    const { a, b, runA, runB } = await twoAgents(page, r)
    await handOff(page, a, b)
    const dlg = page.getByRole('dialog', { name: `Hand off ${a} → ${b}` })
    await expect(dlg).toBeVisible({ timeout: 15_000 })
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dlg).toBeHidden()
    await page.waitForTimeout(2000)
    expect(submissions(r.logs, runB.pid)).toEqual([])
    expect(submissions(r.logs, runA.pid)).toHaveLength(1)
    // a new handoff from A is possible again (one at a time per agent)
    const details = page.getByRole('dialog', { name: `Details for ${a}` })
    if (!(await details.isVisible())) await card(page, a).getByRole('button', { name: a, exact: true }).click()
    await expect(details.getByRole('button', { name: 'Hand off', exact: true })).toBeEnabled()
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

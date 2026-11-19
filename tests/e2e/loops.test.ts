import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanupTemp, expectGone, launch, tempDir } from './helpers'
import { END, openRepo, setupRepo, spawnPreset, START, submissions } from './repo'

test.afterEach(cleanupTemp)

// every loop "second" lasts 50 ms here (test-only env): idle 30 s = 1.5 s, idle 60 s = 3 s
const LOOP_MS = '50'
const card = (page: Page, name: string) => page.locator(`[data-testid=agent-node][data-name="${name}"]`)

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

/** One Frontend agent, resting; its name. */
async function oneAgent(page: Page): Promise<string> {
  await openRepo(page)
  await spawnPreset(page, 'Frontend', 1)
  await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
  return (await page.getByTestId('agent-node').getAttribute('data-name'))!
}

/** Opens the agent's details and its Loop section; returns the dialog. */
async function openLoop(page: Page, name: string) {
  await card(page, name).getByRole('button', { name, exact: true }).click()
  const details = page.getByRole('dialog', { name: `Details for ${name}` })
  await details.getByTestId('loop-section').locator('summary').click()
  return details
}

async function startIdleLoop(details: ReturnType<Page['getByRole']>, name: string, o: { secs: number; prompt: string; goal?: string; maxRuns: number }) {
  await details.getByLabel('Trigger').selectOption({ label: 'When idle' })
  await details.getByLabel('Idle for (s)').fill(String(o.secs))
  await details.getByLabel('Prompt', { exact: true }).fill(o.prompt)
  if (o.goal) await details.getByLabel('Goal').fill(o.goal)
  await details.getByLabel('Max runs').fill(String(o.maxRuns))
  await details.getByRole('button', { name: `Start loop of ${name}` }).click()
}

test('acceptance: an idle loop fires by itself in a resting agent and stops by itself when the reply has the goal', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_LOOP_MS: LOOP_MS })
  try {
    const name = await oneAgent(page)
    const run = r.runs()[0]!
    const details = await openLoop(page, name)
    const status = details.getByTestId('loop-status')
    await expect(status).toHaveText('off')
    await expect(details.getByRole('button', { name: `Start loop of ${name}` })).toBeDisabled() // no prompt yet
    await startIdleLoop(details, name, { secs: 30, prompt: 'REPLY:all tests pass', goal: 'Tests Pass', maxRuns: 5 })
    await expect(status).toHaveText('active · 0/5 runs')
    await expect(details.getByRole('button', { name: 'Pause' })).toBeEnabled()
    await page.waitForTimeout(300) // the buttons' opacity transition
    await page.screenshot({ path: test.info().outputPath('f13.png') })
    // nobody typed anything: after 30 (scaled) seconds resting, the loop's prompt goes in, as one paste + Enter
    await expect.poll(() => submissions(r.logs, run.pid), { timeout: 15_000 }).toEqual([`${START}REPLY:all tests pass${END}`])
    await expect(status).toHaveText('done: Goal reached', { timeout: 15_000 })
    await expect(page.getByText(`Loop of ${name} done, goal reached after 1 run.`)).toBeVisible()
    await expect(details.getByRole('button', { name: 'Resume' })).toBeVisible()
    // done: resting again for many idle periods, nothing else is sent
    await expect(card(page, name)).toHaveAttribute('data-state', 'idle')
    await page.waitForTimeout(4000)
    expect(submissions(r.logs, run.pid)).toHaveLength(1)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('Pause all keeps a loop from firing until Resume all; max runs then pauses it', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_LOOP_MS: LOOP_MS })
  try {
    const name = await oneAgent(page)
    const run = r.runs()[0]!
    await page.getByRole('button', { name: 'Pause all', exact: true }).click()
    await expect(card(page, name).getByTestId('status-word')).toHaveText('paused')
    const details = await openLoop(page, name)
    const status = details.getByTestId('loop-status')
    await startIdleLoop(details, name, { secs: 30, prompt: 'REPLY:ok', maxRuns: 1 })
    await expect(status).toHaveText('active · 0/1 runs')
    await page.waitForTimeout(4500) // three idle periods
    expect(submissions(r.logs, run.pid)).toEqual([])
    await expect(status).toHaveText('active · 0/1 runs') // still active, just held
    await page.getByRole('button', { name: 'Resume all', exact: true }).click()
    await expect.poll(() => submissions(r.logs, run.pid), { timeout: 15_000 }).toEqual([`${START}REPLY:ok${END}`])
    await expect(status).toHaveText('paused: Stopped after 1 run', { timeout: 15_000 })
    await expect(page.getByText(`Loop of ${name} paused, stopped after 1 run.`)).toBeVisible()
    await page.waitForTimeout(3000)
    expect(submissions(r.logs, run.pid)).toHaveLength(1)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('quit and reopen brings the loop back paused ("Paused on reopen"); it only runs again when resumed', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const home = tempDir('nodshell-e2e-home-')
  const env = { ...r.env, HOME: home, NODSHELL_USER_DATA: join(home, 'userdata'), NODSHELL_TEST_RESTORE: 'resume', NODSHELL_TEST_LOOP_MS: LOOP_MS }
  let { app, page, errors } = await launch(env)
  let closed = false
  try {
    const name = await oneAgent(page)
    let details = await openLoop(page, name)
    // a long schedule, so it never fires in the first run of the app
    await details.getByLabel('Trigger').selectOption({ label: 'Schedule' })
    await details.getByLabel('Every (s)').fill('3600')
    await details.getByLabel('Prompt', { exact: true }).fill('REPLY:checked')
    await details.getByLabel('Goal').fill('never matches')
    await details.getByLabel('Max runs').fill('7')
    await details.getByRole('button', { name: `Start loop of ${name}` }).click()
    await expect(details.getByTestId('loop-status')).toHaveText('active · 0/7 runs')
    await page.waitForTimeout(1200) // saved shortly after the change
    await clean(page, errors)
    const first = r.runs().map((x) => x.pid)
    await app.close()
    closed = true
    await expectGone(...first)

    ;({ app, page, errors } = await launch(env))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(card(page, name)).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
    const run = r.runs().find((x) => !first.includes(x.pid))!
    details = await openLoop(page, name)
    const status = details.getByTestId('loop-status')
    await expect(status).toHaveText('paused: Paused on reopen')
    await expect(details.getByLabel('Trigger')).toHaveValue('schedule')
    await expect(details.getByLabel('Every (s)')).toHaveValue('3600')
    await expect(details.getByLabel('Prompt', { exact: true })).toHaveValue('REPLY:checked')
    await expect(details.getByLabel('Goal')).toHaveValue('never matches')
    await expect(details.getByLabel('Max runs')).toHaveValue('7')
    await details.getByRole('button', { name: 'Resume' }).click()
    await expect(status).toHaveText('active · 0/7 runs')
    // saved as an idle loop with a short wait: it runs again
    await details.getByLabel('Trigger').selectOption({ label: 'When idle' })
    await details.getByLabel('Idle for (s)').fill('30')
    await details.getByRole('button', { name: `Save loop of ${name}` }).click()
    await expect(status).toHaveText('active · 0/7 runs')
    await expect.poll(() => submissions(r.logs, run.pid), { timeout: 15_000 }).toEqual([`${START}REPLY:checked${END}`])
    await expect(status).toHaveText('active · 1/7 runs', { timeout: 15_000 })
    await details.getByRole('button', { name: 'Pause' }).click()
    await expect(status).toHaveText('paused: Paused by you')
    await details.getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click() // it asks first
    await expect(status).toHaveText('off')
    await clean(page, errors)
  } finally {
    if (!closed) await app.close()
  }
})

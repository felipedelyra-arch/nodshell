import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { cleanupTemp, expectGone, launch, tempDir } from './helpers'
import { openRepo, setupRepo, spawnAgent, spawnPreset, submissions, type Run } from './repo'

test.afterEach(cleanupTemp)

const card = (page: Page, name: string) => page.locator(`[data-testid=agent-node][data-name="${name}"]`)
const edges = (page: Page) => page.locator('.react-flow__edge-flow')
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
/** The node's place on the canvas (flow coordinates, whatever the zoom). */
const place = (l: Locator) => l.evaluate((el) => (el.closest('.react-flow__node') as HTMLElement).style.transform)
const sessionOf = (run: Run) => run.argv.find((a) => a.startsWith('--session-id='))?.slice('--session-id='.length)
const resumedOf = (run: Run) => run.argv.find((a) => a.startsWith('--resume='))?.slice('--resume='.length)

/** The same user-data dir and HOME on every launch of a test: what one run saves, the next one finds. */
function persistent(r: ReturnType<typeof setupRepo>) {
  const home = tempDir('nodshell-e2e-home-')
  return (restore: 'resume' | 'fresh' | 'empty') => ({ ...r.env, HOME: home, NODSHELL_USER_DATA: join(home, 'userdata'), NODSHELL_TEST_RESTORE: restore })
}

async function createSquad(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Presets', exact: true }).click()
  await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
}

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

/** Quits like the user would and checks that no process is left. */
async function quit(app: Awaited<ReturnType<typeof launch>>['app'], pids: number[]): Promise<void> {
  await app.close()
  await expectGone(...pids)
}

test('acceptance: quit and reopen brings the project, the board, the places and every agent back, resumed in its own worktree', async () => {
  test.setTimeout(300_000)
  const r = setupRepo()
  const env = persistent(r)
  let { app, page, errors } = await launch(env('resume'))
  let closed = false
  try {
    // Workspace 1: a squad, plus an edge of our own (Frontend agent -> REVIEWERS)
    await openRepo(page)
    await createSquad(page)
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await expect.poll(() => r.runs().length, { timeout: 60_000 }).toBe(9)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 60_000 })
    await expect(edges(page)).toHaveCount(4)
    const [front] = await page.locator('[data-testid=agent-node]').evaluateAll((els) => els.filter((e) => e.querySelector('[data-testid=role-tag]')?.textContent === 'frontend').map((e) => e.getAttribute('data-name')!))
    await card(page, front!).getByRole('button', { name: front!, exact: true }).click()
    const details = page.getByRole('dialog', { name: `Details for ${front}` })
    await details.getByLabel('Connect to…').selectOption({ label: 'REVIEWERS group' })
    await details.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(edges(page)).toHaveCount(5)
    await page.keyboard.press('Escape')
    // one agent gets a turn (so its CLI keeps a conversation to resume); the others never got a prompt
    const frontId = await card(page, front!).evaluate((el) => el.closest('.react-flow__node')!.getAttribute('data-id')!)
    await page.evaluate((id) => window.api.invoke('agent:prompt', { id, text: 'REPLY:noted' }), frontId)
    await expect(card(page, front!)).toHaveAttribute('data-state', 'working', { timeout: 10_000 })
    await expect(card(page, front!)).toHaveAttribute('data-state', 'idle', { timeout: 20_000 })

    // Workspace 2: a loose group of two consoles and one console moved by hand
    await page.getByRole('button', { name: 'New workspace' }).click()
    await expect(tab(page, 'Workspace 2')).toHaveAttribute('aria-selected', 'true')
    const consoles = page.getByTestId('terminal-node')
    for (const n of [1, 2]) {
      await page.getByRole('button', { name: 'New console' }).click()
      await expect(consoles).toHaveCount(n)
    }
    await consoles.nth(0).locator('.drag-handle').click({ position: { x: 14, y: 8 } })
    await consoles.nth(1).locator('.drag-handle').click({ position: { x: 14, y: 8 }, modifiers: ['Shift'] })
    await page.locator('button.pill', { hasText: /^Group$/ }).click()
    await page.getByRole('dialog', { name: 'New group' }).getByLabel('Group name').fill('Scratch')
    await page.getByRole('dialog', { name: 'New group' }).getByRole('button', { name: 'Create group' }).click()
    await expect(page.locator('[data-testid=group-node][data-name="Scratch"] [data-testid=group-label]')).toHaveText('SCRATCH 2 · 2 running')
    await page.waitForTimeout(400) // the canvas fits itself to the new group
    await page.getByRole('button', { name: 'New console' }).click()
    await expect(consoles).toHaveCount(3)
    const loose = consoles.nth(2)
    const before = await place(loose)
    const h = (await loose.locator('.drag-handle').boundingBox())!
    await page.mouse.move(h.x + h.width / 2, h.y + 10)
    await page.mouse.down()
    await page.mouse.move(h.x + h.width / 2 + 120, h.y + 90, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => place(loose)).not.toBe(before)

    // what must come back
    const ws2 = { loose: await place(loose), group: await place(page.locator('[data-testid=group-node][data-name="Scratch"]')) }
    await tab(page, 'Workspace 1').click()
    const groupNames = ['Frontend', 'Backend', 'Testers', 'Reviewers']
    const ws1 = { orch: await place(page.getByTestId('orchestrator-node')), groups: await Promise.all(groupNames.map((g) => place(page.locator(`[data-testid=group-node][data-name="${g}"]`)))) }
    const names = (await page.getByTestId('agent-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')!))).sort()
    await tab(page, 'Workspace 2').click()
    const first = r.runs()
    const sessionAt = new Map(first.map((x) => [x.cwd, sessionOf(x)]))
    expect(new Set(sessionAt.values()).size).toBe(9)
    // the prompted agent, and those its turn reached through the edges (Orchestrator, REVIEWERS), had a turn; the rest never did
    const talked = new Set(first.filter((x) => submissions(r.logs, x.pid).length > 0).map((x) => x.cwd))
    expect(talked.size).toBeGreaterThan(0)
    expect(talked.size).toBeLessThan(9)
    await page.waitForTimeout(1200) // the layout is sent 500 ms after the last change
    await clean(page, errors)
    await quit(app, first.map((x) => x.pid))
    closed = true
    expect(r.worktreeCount()).toBe(10) // every agent worktree is kept for the saved board

    // reopen: the project comes back by itself, then the board, resumed
    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await expect(page.getByRole('tab')).toHaveText(['Workspace 1', 'Workspace 2'])
    await expect(tab(page, 'Workspace 2')).toHaveAttribute('aria-selected', 'true') // the one active at quit
    await expect(page.getByTestId('terminal-node')).toHaveCount(3)
    await expect(page.getByTestId('group-node')).toHaveCount(5)
    await expect(page.getByTestId('orchestrator-node')).toHaveCount(1)
    await expect.poll(() => r.runs().length, { timeout: 60_000 }).toBe(18)
    const again = r.runs().filter((x) => !first.some((f) => f.pid === x.pid))
    for (const run of again) {
      expect(sessionAt.has(run.cwd), run.cwd).toBe(true) // the same worktree
      if (talked.has(run.cwd)) {
        expect(resumedOf(run)).toBe(sessionAt.get(run.cwd)) // --resume=<the session it had>
        expect(sessionOf(run)).toBeUndefined()
      } else {
        // no conversation to resume (it never got a prompt): relaunched fresh rather than failing
        expect(resumedOf(run)).toBeUndefined()
        expect(sessionOf(run)).not.toBe(sessionAt.get(run.cwd))
      }
    }
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 60_000 })
    expect((await page.getByTestId('agent-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')!))).sort()).toEqual(names)
    await expect(page.locator('[data-testid=group-node][data-name="Scratch"] [data-testid=group-label]')).toHaveText('SCRATCH 2 · 2 running')
    expect(await place(page.locator('[data-testid=group-node][data-name="Scratch"]'))).toBe(ws2.group)
    const places = await page.getByTestId('terminal-node').evaluateAll((els) => els.map((el) => (el.closest('.react-flow__node') as HTMLElement).style.transform))
    expect(places).toContain(ws2.loose)
    await expect(edges(page)).toHaveCount(0) // edges are drawn on their own board
    await tab(page, 'Workspace 1').click()
    await expect(edges(page)).toHaveCount(5)
    expect(await place(page.getByTestId('orchestrator-node'))).toBe(ws1.orch)
    expect(await Promise.all(groupNames.map((g) => place(page.locator(`[data-testid=group-node][data-name="${g}"]`))))).toEqual(ws1.groups)
    for (const g of groupNames) await expect(page.locator(`[data-testid=group-node][data-name="${g}"] [data-testid=group-label]`)).toHaveText(`${g.toUpperCase()} 2 · 2 running`)
    await expect(page.getByTestId('orch-summary')).toContainText('8 agents · 4 groups')
    await expect(page.getByTestId('live-badge')).toHaveText(/^9 live/)
    await clean(page, errors)
    await quit(app, again.map((x) => x.pid))
    closed = true
  } finally {
    if (!closed) await app.close()
  }
})

test('Start fresh relaunches each agent in its worktree with a new session; Empty board discards the board and cleans the worktrees', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const env = persistent(r)
  let { app, page, errors } = await launch(env('fresh'))
  let closed = false
  try {
    await openRepo(page)
    await spawnAgent(page, 'solo', 'haiku', 1)
    await expect.poll(() => r.runs().length).toBe(1)
    const [run] = r.runs()
    const name = await page.getByTestId('agent-node').getAttribute('data-name')
    await page.waitForTimeout(800)
    await clean(page, errors)
    await quit(app, [run!.pid])
    closed = true

    ;({ app, page, errors } = await launch(env('fresh')))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByTestId('agent-node')).toHaveAttribute('data-name', name!)
    await expect.poll(() => r.runs().length).toBe(2)
    const fresh = r.runs().find((x) => x.pid !== run!.pid)!
    expect(fresh.cwd).toBe(run!.cwd)
    expect(resumedOf(fresh)).toBeUndefined()
    expect(sessionOf(fresh)).toMatch(/^[0-9a-f-]{36}$/)
    expect(sessionOf(fresh)).not.toBe(sessionOf(run!))
    await clean(page, errors)
    await quit(app, [fresh.pid])
    closed = true

    // Empty board: nothing comes back, the clean worktree and its branch are removed
    ;({ app, page, errors } = await launch(env('empty')))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByText('No terminals yet')).toBeVisible()
    await expect.poll(() => r.worktreeCount()).toBe(1)
    expect(r.agentBranches()).toEqual([])
    expect(r.runs()).toHaveLength(2)
    await clean(page, errors)
    await app.close()
    closed = true

    // and the next start has nothing to ask about
    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await clean(page, errors)
  } finally {
    if (!closed) await app.close()
  }
})

test('an agent whose worktree was deleted by hand does not come back; the others do, and one notice says why', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const env = persistent(r)
  let { app, page, errors } = await launch(env('resume'))
  let closed = false
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.getByTestId('agent-node')).toHaveCount(2)
    await expect.poll(() => r.runs().length).toBe(2)
    const first = r.runs()
    const gone = first[0]!
    await page.waitForTimeout(800)
    await clean(page, errors)
    await quit(app, first.map((x) => x.pid))
    closed = true
    rmSync(gone.cwd, { recursive: true, force: true })

    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByRole('status').filter({ hasText: 'did not come back' })).toContainText(/1 terminal did not come back: \w+ \(agent\/frontend-\d, its worktree is missing\)\./)
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 1 · 1 running')
    await expect.poll(() => r.runs().length).toBe(3)
    const back = r.runs().find((x) => !first.some((f) => f.pid === x.pid))!
    expect(back.cwd).toBe(first[1]!.cwd)
    expect(existsSync(gone.cwd)).toBe(false) // nothing recreated it
    const goneBranch = r.agentBranches().find((b) => gone.cwd.endsWith(b.slice('agent/'.length)))!
    expect(goneBranch).toBeDefined()
    await page.waitForTimeout(800)
    await clean(page, errors)
    await quit(app, [back.pid])
    closed = true

    // it stays on the saved board: the next start tries it again
    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByRole('status').filter({ hasText: 'did not come back' })).toContainText(`(${goneBranch}, its worktree is missing, again)`)
    await expect.poll(() => r.runs().length).toBe(4)
    await page.waitForTimeout(800)
    await clean(page, errors)
    await quit(app, r.runs().slice(-1).map((x) => x.pid))
    closed = true

    // Empty board: the worktree that checks out is cleaned up; the broken one is never touched, only named with its branch
    ;({ app, page, errors } = await launch(env('empty')))
    closed = false
    await expect(page.getByRole('status').filter({ hasText: 'Board emptied' })).toContainText(`Left as they are, check them yourself: `)
    await expect(page.getByRole('status').filter({ hasText: 'Board emptied' })).toContainText(`on ${goneBranch} (its worktree is missing)`)
    await expect.poll(() => r.agentBranches()).toEqual([goneBranch])
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await clean(page, errors)
    await app.close()
    closed = true
    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('agent-node')).toHaveCount(0) // the records went with Empty board
    await clean(page, errors)
  } finally {
    if (!closed) await app.close()
  }
})

test('Memory: both tabs saved and back after a restart; Copy to command bar only fills the field; an agent writes and reads it', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const env = persistent(r)
  let { app, page, errors } = await launch(env('resume'))
  let closed = false
  try {
    await openRepo(page)
    await spawnAgent(page, 'solo', 'haiku', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const [run] = r.runs()
    const agentName = (await page.getByTestId('agent-node').getAttribute('data-name'))!

    const pill = page.getByRole('button', { name: 'Memory', exact: true })
    await pill.click()
    const dlg = page.getByRole('dialog', { name: 'Memory' })
    await expect(tab(page, 'This repository')).toHaveAttribute('aria-selected', 'true')
    const text = dlg.getByTestId('memory-text')
    const save = dlg.getByRole('button', { name: 'Save' })
    await expect(dlg.getByTestId('memory-edited')).toHaveText('Not edited yet')
    await expect(save).toBeDisabled() // nothing changed yet
    await text.fill('# Repo\nuse pnpm')
    await expect(dlg.getByTestId('memory-size')).toHaveText('15 B / 64 KiB')
    await save.click()
    await expect(dlg.getByTestId('memory-edited')).toContainText('Last edited by you at')
    await expect(save).toBeDisabled()
    await tab(page, 'Global').click()
    await text.fill('global note')
    // unsaved changes: closing asks inside the dialog
    await page.keyboard.press('Escape')
    await expect(dlg.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeVisible()
    await dlg.getByRole('button', { name: 'Keep editing' }).click()
    await save.click()
    await expect(dlg.getByTestId('memory-edited')).toContainText('Last edited by you at')
    await page.screenshot({ path: test.info().outputPath('f8.png') })

    // copy: appended to the command field, never sent; the dialog closes and the focus goes back to the pill
    await dlg.getByRole('button', { name: 'Copy to command bar' }).click()
    await expect(dlg).toHaveCount(0)
    await expect(pill).toBeFocused()
    await expect(page.getByRole('combobox', { name: 'Command', exact: true })).toHaveValue('global note')
    await page.waitForTimeout(1500)
    expect(submissions(r.logs, run!.pid)).toEqual([])

    // an agent writes its repository's memory and reads it back through its tools
    const agentId = await page.getByTestId('agent-node').evaluate((el) => el.closest('.react-flow__node')!.getAttribute('data-id')!)
    const ask = (t: string) => page.evaluate(([id, t]) => window.api.invoke('agent:prompt', { id: id!, text: t! }), [agentId, t])
    const mcp = () => {
      try {
        return readFileSync(join(r.logs, `${run!.pid}.mcp`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { result?: { content: { text: string }[] } })
      } catch {
        return []
      }
    }
    await ask('MCPCALL memory_write {"scope":"repo","content":"from the agent","mode":"append"}')
    await expect.poll(() => mcp().length, { timeout: 20_000 }).toBe(1)
    expect(mcp()[0]!.result!.content[0]!.text).toBe('Saved the repo memory')
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    await ask('MCPCALL memory_read {"scope":"repo"}')
    await expect.poll(() => mcp().length, { timeout: 20_000 }).toBe(2)
    expect(mcp()[1]!.result!.content[0]!.text).toBe('# Repo\nuse pnpm\nfrom the agent')
    await pill.click()
    await expect(dlg.getByTestId('memory-text')).toHaveValue('# Repo\nuse pnpm\nfrom the agent')
    await expect(dlg.getByTestId('memory-edited')).toContainText(`Last edited by ${agentName} at`)
    await page.keyboard.press('Escape') // nothing unsaved: closes at once
    await expect(dlg).toHaveCount(0)
    await expect(pill).toBeFocused()
    await page.waitForTimeout(800)
    await clean(page, errors)
    await app.close()
    closed = true

    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Memory' }).getByTestId('memory-text')).toHaveValue('# Repo\nuse pnpm\nfrom the agent')
    await tab(page, 'Global').click()
    await expect(page.getByRole('dialog', { name: 'Memory' }).getByTestId('memory-text')).toHaveValue('global note')
    await clean(page, errors)
  } finally {
    if (!closed) await app.close()
  }
})

test('a console opened before the project stays (card and process) when the project brings its saved board back, and is saved with it', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const r2 = setupRepo()
  const env = persistent(r)
  let { app, page, errors } = await launch(env('resume'))
  let closed = false
  try {
    await openRepo(page)
    await spawnAgent(page, 'solo', 'haiku', 1)
    await expect.poll(() => r.runs().length).toBe(1)
    const name = (await page.getByTestId('agent-node').getAttribute('data-name'))!
    // another project: the first one is saved, and the other becomes the last one opened
    await app.evaluate((_e, dir) => void (process.env['NODSHELL_TEST_REPO'] = dir), r2.repo)
    await page.getByTestId('workspace').click()
    await page.getByRole('menuitem', { name: 'Open folder…' }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expectGone(r.runs()[0]!.pid)
    await clean(page, errors)
    await app.close()
    closed = true
    rmSync(r2.repo, { recursive: true, force: true }) // the last project is gone: the next start is empty

    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByRole('button', { name: 'Open repository' })).toBeVisible()
    await page.getByRole('button', { name: 'New console' }).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await openRepo(page) // the first project, with its saved board
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByTestId('agent-node')).toHaveAttribute('data-name', name)
    await expect(page.getByTestId('terminal-node')).toHaveCount(1) // still there, beside the restored card
    await expect(page.getByTestId('terminal-node')).toBeVisible()
    const c = (await page.getByTestId('terminal-node').boundingBox())!
    const a = (await page.getByTestId('agent-node').boundingBox())!
    expect(c.x >= a.x + a.width || c.y >= a.y + a.height || a.x >= c.x + c.width).toBe(true) // never on top of it
    await expect(page.getByTestId('live-badge')).toHaveText(/^1 live/)
    await expect.poll(() => r.runs().length).toBe(2)
    await page.waitForTimeout(800)
    await clean(page, errors)
    await app.close()
    closed = true

    // main saved it too: both come back
    ;({ app, page, errors } = await launch(env('resume')))
    closed = false
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await clean(page, errors)
  } finally {
    if (!closed) await app.close()
  }
})

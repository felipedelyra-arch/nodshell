import { expect, test, type Page } from '@playwright/test'
import { alive, cleanupTemp, expectGone, launch, newConsole, typeIn } from './helpers'
import { openRepo, setupRepo, spawnAgent, spawnPreset } from './repo'

test.afterEach(cleanupTemp)

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform)
const addWorkspace = (page: Page) => page.getByRole('button', { name: 'New workspace' }).click()
const closeWorkspace = (page: Page) => page.getByRole('button', { name: 'Close workspace' }).click()

test('workspaces: terminals stay mounted across tabs, viewport per board, keyboard, live count is global', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    // "+" needs a repository
    await expect(page.getByRole('button', { name: 'New workspace' })).toHaveAttribute('aria-disabled', 'true')
    await openRepo(page)
    await expect(page.getByRole('button', { name: 'New workspace' })).not.toHaveAttribute('aria-disabled', 'true')

    await newConsole(page, 1)
    await typeIn(page, 0, 'echo WS1-MARK')
    const body1 = page.getByTestId('terminal-body').first()
    await expect(body1).toContainText('WS1-MARK')
    await page.locator('.xterm').first().evaluate((el) => el.setAttribute('data-mark', 'one'))
    await page.mouse.move(900, 600)
    await page.mouse.down()
    await page.mouse.move(980, 650, { steps: 5 })
    await page.mouse.up()
    const vp1 = await viewport(page)
    expect(vp1).not.toContain('translate(0px, 0px)')

    await addWorkspace(page)
    await expect(page.getByRole('tab')).toHaveText(['Workspace 1', 'Workspace 2'])
    await expect(tab(page, 'Workspace 2')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'Workspace 1')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByText('No terminals yet')).toBeVisible()
    await expect(page.getByTestId('terminal-node')).toBeHidden() // mounted, not shown
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    expect(await viewport(page)).toContain('translate(0px, 0px)') // a new board starts at the origin
    await page.mouse.click(900, 600) // focus leaves the "+" button, which Enter would press again
    await page.keyboard.type('echo LEAK') // nothing listens: the hidden terminal gets no keys
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape') // on the board those letters are tool shortcuts (the eraser, here): back to selection

    await spawnAgent(page, 'builder', 'haiku', 1)
    await expect(page.getByTestId('agent-node')).toBeVisible()
    await expect(page.getByText('No terminals yet')).toHaveCount(0)
    await expect(page.getByTestId('live-badge')).toHaveText(/^1 live/)
    await expect(page.getByTestId('worktree-count')).toHaveText('· 1')
    await page.screenshot({ path: test.info().outputPath('c6.png') })

    // back to the first board: the very same terminal element, output intact, own viewport; the agent is hidden
    await tab(page, 'Workspace 1').click()
    await expect(page.getByTestId('terminal-node')).toBeVisible()
    await expect(page.getByTestId('agent-node')).toBeHidden()
    await expect(page.locator('.xterm').first()).toHaveAttribute('data-mark', 'one')
    await expect(body1).toContainText('WS1-MARK')
    await expect(body1).not.toContainText('LEAK')
    expect(await viewport(page)).toBe(vp1)
    await expect(page.getByTestId('live-badge')).toHaveText(/^1 live/)
    await expect(page.getByTestId('worktree-count')).toHaveText('· 1')
    // the shell still works after the round trip
    await typeIn(page, 0, 'echo STILL-HERE')
    await expect(body1).toContainText('STILL-HERE')

    // keyboard: arrows move and activate (roving tab index), Enter activates a focused tab
    const t1 = tab(page, 'Workspace 1')
    const t2 = tab(page, 'Workspace 2')
    await expect(t1).toHaveAttribute('tabindex', '0')
    await expect(t2).toHaveAttribute('tabindex', '-1')
    await t1.focus()
    await page.keyboard.press('ArrowRight')
    await expect(t2).toHaveAttribute('aria-selected', 'true')
    await expect(t2).toBeFocused()
    await page.keyboard.press('ArrowRight') // past the end: stays
    await expect(t2).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(t1).toHaveAttribute('aria-selected', 'true')
    await expect(t1).toBeFocused()
    await t2.focus()
    await page.keyboard.press('Enter')
    await expect(t2).toHaveAttribute('aria-selected', 'true')
    await t1.focus()
    await page.keyboard.press('Space')
    await expect(t1).toHaveAttribute('aria-selected', 'true')

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('workspaces: Close asks once for the whole workspace, ends only its terminals, activates the neighbour', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  // "no" keeps everything, then "yes"; a third answer ("no") would stop a second agent if the question were asked per terminal
  const { app, page, errors } = await launch({ ...r.env, AGENT_CANVAS_TEST_CLOSE: 'no,yes,no' })
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await addWorkspace(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.getByTestId('agent-node')).toHaveCount(2)
    await expect(page.getByTestId('agent-node').first().getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await expect.poll(() => r.runs().length).toBe(2)
    const pids = r.runs().map((x) => x.pid)
    expect(r.worktreeCount()).toBe(3)

    await closeWorkspace(page) // asked: "no"
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByTestId('agent-node')).toHaveCount(2)
    expect(pids.every(alive)).toBe(true)

    await closeWorkspace(page) // asked once: "yes"
    await expect(page.getByRole('tab')).toHaveText(['Workspace 1'])
    await expect(tab(page, 'Workspace 1')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expect(page.getByTestId('group-node')).toHaveCount(0)
    await expectGone(...pids)
    await expect.poll(() => r.worktreeCount()).toBe(1)
    expect(r.agentBranches()).toEqual([])
    // the other workspace's console was left alone
    await expect(page.getByTestId('terminal-node')).toBeVisible()
    await expect(page.getByTestId('live-badge')).toHaveText(/^0 live/)

    // numbers are not reused
    await addWorkspace(page)
    await expect(page.getByRole('tab')).toHaveText(['Workspace 1', 'Workspace 3'])
    await tab(page, 'Workspace 1').click()
    await closeWorkspace(page) // an idle shell: no question
    await expect(page.getByRole('tab')).toHaveText(['Workspace 3'])
    await expect(tab(page, 'Workspace 3')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('terminal-node')).toHaveCount(0)

    // the last one: it empties and a fresh "Workspace 1" stays
    await closeWorkspace(page)
    await expect(page.getByRole('tab')).toHaveText(['Workspace 1'])
    await expect(tab(page, 'Workspace 1')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('No terminals yet')).toBeVisible()

    // limit: eight workspaces, then "+" is disabled with a tip
    for (let i = 0; i < 7; i++) await addWorkspace(page)
    await expect(page.getByRole('tab')).toHaveCount(8)
    const plus = page.getByRole('button', { name: 'New workspace' })
    await expect(plus).toHaveAttribute('aria-disabled', 'true')
    await expect(plus).toHaveAttribute('data-tip', 'At most 8 workspaces')
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('project menu: keyboard, same folder changes nothing, another folder asks once and starts a clean Workspace 1', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const r2 = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, AGENT_CANVAS_TEST_CLOSE: 'no,yes' })
  try {
    await openRepo(page) // no project yet: the chip opens the folder dialog directly
    const chip = page.getByTestId('workspace')
    await expect(chip).toHaveAccessibleName('Project demo repo, menu')
    await expect(chip).toHaveAttribute('aria-haspopup', 'menu')

    await chip.click()
    const menu = page.getByRole('menu', { name: 'Project' })
    const current = menu.getByRole('menuitemradio')
    const folder = menu.getByRole('menuitem', { name: 'Open folder…' })
    await expect(current).toHaveAttribute('aria-checked', 'true')
    await expect(current).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(folder).toBeFocused()
    await page.keyboard.press('ArrowDown') // wraps
    await expect(current).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(chip).toBeFocused()

    await spawnAgent(page, 'builder', 'haiku', 1)
    await addWorkspace(page)
    await expect.poll(() => r.runs().length).toBe(1)
    const pid = r.runs()[0]!.pid

    // the same folder again: nothing is asked, nothing is closed
    await chip.click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByRole('tab')).toHaveCount(2)

    // another folder: "no" keeps everything, "yes" ends it and starts clean
    await app.evaluate((_e, dir) => void (process.env['AGENT_CANVAS_TEST_REPO'] = dir), r2.repo)
    await chip.click()
    await folder.click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByRole('tab')).toHaveCount(2)
    expect(alive(pid)).toBe(true)
    await chip.click()
    await folder.click()
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveText(['Workspace 1'])
    await expect(tab(page, 'Workspace 1')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('No terminals yet')).toBeVisible()
    await expectGone(pid)
    // F8: the old project's agent worktree stays for its saved board
    expect(r.worktreeCount()).toBe(2)

    // agents now start in the new project
    await spawnAgent(page, 'builder', 'haiku', 1)
    await expect.poll(() => r2.agentBranches().length).toBe(1)
    expect(r.agentBranches()).toEqual(['agent/builder-1'])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('Spawn N of the same preset in two workspaces makes two independent groups; closing one workspace leaves the other', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.getByTestId('agent-node')).toHaveCount(2)
    await addWorkspace(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.getByTestId('agent-node')).toHaveCount(4)
    await expect(page.getByTestId('group-node')).toHaveCount(2)
    // each board shows only its own group, with its own two members
    await expect(page.getByTestId('group-node').filter({ visible: true })).toHaveCount(1)
    await expect(page.getByTestId('group-label').filter({ visible: true })).toHaveText('FRONTEND 2 · 2 running')
    await expect(page.getByTestId('agent-node').filter({ visible: true })).toHaveCount(2)
    await tab(page, 'Workspace 1').click()
    await expect(page.getByTestId('group-label').filter({ visible: true })).toHaveText('FRONTEND 2 · 2 running')
    await expect(page.getByTestId('agent-node').filter({ visible: true })).toHaveCount(2)
    await expect.poll(() => r.runs().length).toBe(4)

    await closeWorkspace(page) // asked: the answer is "yes"
    await expect(page.getByRole('tab')).toHaveText(['Workspace 2'])
    await expect(page.getByTestId('agent-node')).toHaveCount(2)
    await expect(page.getByTestId('group-node')).toHaveCount(1)
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 2 · 2 running')
    await expect(page.getByTestId('agent-node').first()).toBeVisible()
    await expect(page.getByTestId('live-badge')).toHaveText(/^2 live/)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

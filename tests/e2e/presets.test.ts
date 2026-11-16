import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { alive, cleanupTemp, expectGone, launch, newConsole, typeIn } from './helpers'
import { openRepo, setupRepo, spawnPreset } from './repo'

test.afterEach(cleanupTemp)

const box = async (l: Locator) => (await l.boundingBox())!
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

test('top bar, workspace and branch label', async () => {
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    const home = page.getByRole('button', { name: /Back to home/ })
    await expect(home).toHaveAttribute('aria-disabled', 'true')
    await expect(home).toHaveAttribute('data-tip', 'Home arrives in a later phase')
    await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Workspace 1' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('repo-badge')).toHaveCount(0) // no repository, no branch
    await expect(page.locator('button.pill')).toHaveText(['New console', 'Spawn 4', 'Group', 'Presets', 'Pause all', 'Resume all', 'Memory', 'Close all'])
    await expect(page.getByTestId('live-badge')).toHaveText(/^0 live/)

    await page.getByRole('button', { name: 'Open folder' }).click()
    await expect(page.getByTestId('workspace-name')).toHaveText('demo repo')
    await expect(page.getByTestId('workspace')).toHaveAccessibleName('Project demo repo, menu')
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('repo-badge').getByRole('img', { name: 'Git branch' })).toBeVisible()
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('Spawn 4 of Frontend: four grouped agents, label, collapse keeps terminals, close updates the count', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, tmp, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 4)
    const cards = page.getByTestId('agent-node')
    await expect(cards).toHaveCount(4)
    await expect(page.getByTestId('group-node')).toHaveCount(1)
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 4 · 4 running')
    const names = await Promise.all([0, 1, 2, 3].map((i) => cards.nth(i).getAttribute('data-name')))
    for (const n of names) expect(n).toMatch(/^[A-Z][a-z]{1,4}$/)
    expect(new Set(names.map((n) => n!.toLowerCase())).size).toBe(4)
    for (const i of [0, 1, 2, 3]) await expect(cards.nth(i).getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')

    // the cards sit inside the group frame, one row
    const frame = await box(page.locator('.group-frame'))
    const boxes = await Promise.all([0, 1, 2, 3].map((i) => box(cards.nth(i))))
    for (const b of boxes) expect(inside(b, frame)).toBe(true)
    for (const b of boxes) expect(Math.abs(b.y - boxes[0]!.y)).toBeLessThan(2)
    for (let i = 1; i < 4; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x + boxes[i - 1]!.width - 1)
    // thin frame, label on its top edge near the left corner
    const label = await box(page.getByTestId('group-label'))
    expect(Math.abs(label.y + label.height / 2 - frame.y)).toBeLessThan(4)
    expect(label.x).toBeLessThan(frame.x + 80)

    // four distinct worktrees, the preset's system prompt reached the CLI
    await expect.poll(() => r.runs().length).toBe(4)
    const runs = r.runs()
    expect(runs.map((x) => basename(x.cwd)).sort()).toEqual(['frontend-1', 'frontend-2', 'frontend-3', 'frontend-4'])
    expect(new Set(runs.map((x) => x.cwd)).size).toBe(4)
    for (const run of runs) expect(run.argv.find((a) => a.startsWith('--append-system-prompt='))).toMatch(/^--append-system-prompt=You are a frontend engineer\./)
    expect(r.agentBranches().sort()).toEqual(['agent/frontend-1', 'agent/frontend-2', 'agent/frontend-3', 'agent/frontend-4'])
    expect(r.worktreeCount()).toBe(5)
    await expect(page.getByTestId('live-badge')).toHaveText(/^4 live/)

    // closing one card: the label counts 3
    await page.getByRole('button', { name: `Close ${names[3]}` }).click()
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 3 · 3 running')
    await expect(cards).toHaveCount(3)
    const pids = runs.filter((x) => basename(x.cwd) !== 'frontend-4').map((x) => x.pid)

    // output typed before collapsing is still there after expanding; the processes live meanwhile
    await typeIn(page, 0, 'hello')
    await expect(cards.nth(0).getByTestId('terminal-body')).toContainText('SUBMITTED 1')
    const collapse = page.getByRole('button', { name: 'Collapse FRONTEND' })
    await expect(collapse).toHaveAttribute('aria-expanded', 'true')
    await collapse.click()
    for (const i of [0, 1, 2]) await expect(cards.nth(i)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Expand FRONTEND' })).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 3 · 3 running')
    await page.waitForTimeout(500)
    for (const pid of pids) expect(alive(pid)).toBe(true)
    await page.getByRole('button', { name: 'Expand FRONTEND' }).click()
    for (const i of [0, 1, 2]) await expect(cards.nth(i)).toBeVisible()
    await expect(cards.nth(0).getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await expect(cards.nth(0).getByTestId('terminal-body')).toContainText('SUBMITTED 1')

    // closing the rest removes the group
    for (const n of names.slice(0, 3)) await page.getByRole('button', { name: `Close ${n}` }).click()
    await expect(page.getByTestId('group-node')).toHaveCount(0)
    await expectGone(...r.runs().map((x) => x.pid))
    await expect.poll(() => r.agentBranches()).toEqual([])
    expect(r.worktreeCount()).toBe(1)
    expect(existsSync(join(tmp, 'userdata', 'nodshell.db'))).toBe(true)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('asking for more agents than free slots is refused and creates nothing', async () => {
  test.setTimeout(240_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 8)
    await expect(page.getByTestId('agent-node')).toHaveCount(8)
    await spawnPreset(page, 'Frontend', 8) // same preset: same group
    await expect(page.getByTestId('agent-node')).toHaveCount(16)
    await expect(page.getByTestId('group-node')).toHaveCount(1)
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 16 · 16 running')
    await expect.poll(() => r.runs().length).toBe(16)

    await spawnPreset(page, 'Backend', 6) // 4 of 20 slots left
    const alert = page.getByRole('alert')
    await expect(alert).toHaveText('Only 4 of 20 terminals are free, cannot start 6.')
    await page.waitForTimeout(500)
    await expect(page.getByTestId('agent-node')).toHaveCount(16)
    await expect(page.getByTestId('group-node')).toHaveCount(1)
    expect(r.runs()).toHaveLength(16)
    expect(r.agentBranches().filter((b) => b.includes('backend'))).toEqual([])
    expect(r.worktreeCount()).toBe(17)
    await page.keyboard.press('Escape')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('presets: create, validate, edit, delete, built-ins, focus handling, persistence across restarts', async () => {
  test.setTimeout(90_000)
  const r = setupRepo()
  const first = await launch(r.env)
  let page = first.page
  let app = first.app
  const dialog = () => page.getByRole('dialog', { name: 'Presets' })
  const item = (name: string) => dialog().getByRole('button', { name, exact: true })
  try {
    const pill = page.getByRole('button', { name: 'Presets', exact: true })
    await pill.click()
    await expect(dialog()).toBeVisible()
    await expect(dialog().getByRole('list', { name: 'Preset list' }).getByRole('listitem')).toHaveCount(6) // five built-ins + "New preset"
    for (const n of ['Frontend', 'Backend', 'Testers', 'Reviewers', 'Orchestrator']) await expect(dialog().getByRole('button', { name: new RegExp(`^${n}`) })).toBeVisible()

    // built-in: editable, no Delete
    await dialog().getByRole('button', { name: /^Frontend/ }).click()
    await expect(dialog().getByLabel('Name')).toHaveValue('Frontend')
    await expect(dialog().getByLabel('Role')).toHaveValue('frontend')
    await expect(dialog().getByRole('button', { name: 'Delete' })).toHaveCount(0)

    // focus stays trapped inside
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog().evaluate((d) => d.contains(document.activeElement))).toBe(true)
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await dialog().evaluate((d) => d.contains(document.activeElement))).toBe(true)
    }

    // create, with inline validation
    await dialog().getByRole('button', { name: '+ New preset' }).click()
    await dialog().getByRole('button', { name: 'Save' }).click()
    await expect(dialog().getByLabel('Name')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog().getByLabel('Role')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog().getByText('Name must be 1 to 40 characters.')).toBeVisible()
    await dialog().getByLabel('Name').fill('Docs writer')
    await dialog().getByLabel('Role').fill('../x')
    await expect(dialog().getByText(/Use lowercase letters, digits and dashes/)).toBeVisible()
    await dialog().getByLabel('Role').fill('docs')
    await dialog().getByLabel('Model').selectOption('haiku')
    const prompt = `Write "docs"; it's 'fine'\nDROP TABLE presets;--\nsecond line`
    await dialog().getByLabel('System prompt').fill(prompt)
    await dialog().getByRole('button', { name: 'Save' }).click()
    await expect(item('Docs writer')).toBeVisible()
    await expect(item('Docs writer')).toHaveAttribute('aria-current', 'true')

    // duplicate name, any case
    await dialog().getByRole('button', { name: '+ New preset' }).click()
    await dialog().getByLabel('Name').fill('DOCS WRITER')
    await dialog().getByLabel('Role').fill('docs2')
    await dialog().getByRole('button', { name: 'Save' }).click()
    await expect(dialog().getByRole('alert')).toHaveText('A preset with that name already exists.')

    // Esc closes and returns the focus to the pill
    await page.keyboard.press('Escape')
    await expect(dialog()).toHaveCount(0)
    await expect(pill).toBeFocused()

    // the app is restarted with the same data dir: the preset is still there, fields intact
    const userdata = join(first.tmp, 'userdata')
    expect(statSync(join(userdata, 'nodshell.db')).mode & 0o777).toBe(0o600)
    await clean(page, first.errors)
    await app.close()
    const second = await launch({ ...r.env, NODSHELL_USER_DATA: userdata })
    app = second.app
    page = second.page
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await expect(dialog().getByRole('list', { name: 'Preset list' }).getByRole('listitem')).toHaveCount(7)
    await item('Docs writer').click()
    await expect(dialog().getByLabel('Role')).toHaveValue('docs')
    await expect(dialog().getByLabel('Model')).toHaveValue('haiku')
    await expect(dialog().getByLabel('System prompt')).toHaveValue(prompt)

    // edit
    await dialog().getByLabel('Name').fill('Docs team')
    await dialog().getByLabel('Model').selectOption('')
    await dialog().getByRole('button', { name: 'Save' }).click()
    await expect(item('Docs team')).toBeVisible()
    await expect(item('Docs writer')).toHaveCount(0)
    await expect(dialog().getByLabel('Model')).toHaveValue('')

    // delete asks first; Esc backs out of the confirmation only
    await dialog().getByRole('button', { name: 'Delete' }).click()
    await expect(dialog().getByText('Delete “Docs team”?')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog()).toBeVisible()
    await expect(dialog().getByText('Delete “Docs team”?')).toHaveCount(0)
    await dialog().getByRole('button', { name: 'Delete' }).click()
    await dialog().getByRole('button', { name: 'Keep' }).click()
    await expect(item('Docs team')).toBeVisible()
    await dialog().getByRole('button', { name: 'Delete' }).click()
    await dialog().getByRole('button', { name: 'Confirm delete' }).click()
    await expect(item('Docs team')).toHaveCount(0)
    await expect(dialog().getByRole('list', { name: 'Preset list' }).getByRole('listitem')).toHaveCount(6)

    // the edited built-in is used by Spawn: the new system prompt reaches the fake
    await dialog().getByRole('button', { name: /^Reviewers/ }).click()
    await dialog().getByLabel('System prompt').fill('Review strictly.\nSecond line.')
    await dialog().getByRole('button', { name: 'Save' }).click()
    await expect(dialog().getByLabel('System prompt')).toHaveValue('Review strictly.\nSecond line.')
    await dialog().getByRole('button', { name: 'Close' }).click()
    await openRepo(page)
    await spawnPreset(page, 'Reviewers', 1)
    await expect(page.getByTestId('agent-node')).toHaveCount(1)
    await expect(page.getByTestId('group-label')).toHaveText('REVIEWERS 1 · 1 running')
    await expect.poll(() => r.runs().length).toBe(1)
    expect(r.runs()[0]!.argv).toContain('--append-system-prompt=Review strictly.\nSecond line.')
    await clean(page, second.errors)
  } finally {
    await app.close()
  }
})

test('Group groups selected consoles under a typed name; ungroup dissolves it in place', async () => {
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await newConsole(page, 1)
    await newConsole(page, 2)
    const group = page.locator('button.pill', { hasText: /^Group$/ })
    await expect(group).toHaveAttribute('aria-disabled', 'true')
    await expect(group).toHaveAttribute('data-tip', 'Select two or more cards first (Shift+click)')
    const headers = page.locator('.drag-handle')
    await headers.nth(0).click({ position: { x: 14, y: 8 } })
    await expect(group).toHaveAttribute('aria-disabled', 'true') // one card is not enough
    await headers.nth(1).click({ position: { x: 14, y: 8 }, modifiers: ['Shift'] })
    await expect(group).toHaveAttribute('aria-disabled', 'false')
    await group.click()
    const dlg = page.getByRole('dialog', { name: 'New group' })
    await expect(dlg.getByRole('button', { name: 'Create group' })).toBeDisabled()
    await dlg.getByLabel('Group name').fill('Scratch')
    await dlg.getByRole('button', { name: 'Create group' }).click()
    await expect(page.getByTestId('group-label')).toHaveText('SCRATCH 2 · 2 running')
    // the canvas fits itself to the new group a moment later: measure frame and cards together until they settle
    for (const i of [0, 1]) await expect.poll(async () => inside(await box(page.getByTestId('terminal-node').nth(i)), await box(page.locator('.group-frame')))).toBe(true)
    await expect(group).toHaveAttribute('aria-disabled', 'true') // grouped cards are no longer selectable

    // dragging the frame moves the cards with it (after the canvas has fitted itself to the new group)
    await page.waitForTimeout(400)
    const before = await box(page.getByTestId('terminal-node').nth(0))
    const f = await box(page.locator('.group-frame'))
    await page.mouse.move(f.x + f.width / 2, f.y + 6)
    await page.mouse.down()
    await page.mouse.move(f.x + f.width / 2 + 40, f.y + 46, { steps: 5 })
    await page.mouse.up()
    // the node positions follow the pointer a frame later; the first mouse step only starts the drag
    await expect.poll(async () => (await box(page.getByTestId('terminal-node').nth(0))).x - before.x).toBeGreaterThan(20)
    await page.waitForTimeout(150)
    const moved = await box(page.getByTestId('terminal-node').nth(0))
    expect(Math.round(moved.y - before.y)).toBe(Math.round(moved.x - before.x))

    await page.getByRole('button', { name: 'Ungroup SCRATCH' }).click()
    await expect(page.getByTestId('group-node')).toHaveCount(0)
    await expect(page.getByTestId('terminal-node')).toHaveCount(2)
    const after = await box(page.getByTestId('terminal-node').nth(0))
    expect(Math.abs(after.x - moved.x)).toBeLessThan(2)
    expect(Math.abs(after.y - moved.y)).toBeLessThan(2)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

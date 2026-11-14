import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, cleanupTemp, expectGone, launch, newConsole, typeIn } from './helpers'
import { END, openRepo, setupRepo, spawnAgent, spawnPreset, START } from './repo'

test.afterEach(cleanupTemp)

const box = async (l: Locator) => (await l.boundingBox())!

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

test('agent card: one-line header, details popover by click and keyboard, prompt from the popover', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await spawnAgent(page, 'builder', 'haiku', 1)
    const card = page.getByTestId('agent-node').nth(0)
    await expect(card.getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await expect(card).toHaveAttribute('data-state', 'idle')
    const name = (await card.getAttribute('data-name'))!

    // header: short name, red role tag, status pill, three icon buttons; no model, branch or time
    const head = card.locator('.card-head')
    await expect(head.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(head.getByTestId('role-tag')).toHaveText('builder')
    await expect(head.getByTestId('status-word')).toHaveText('resting')
    await expect(head.getByRole('button')).toHaveCount(4) // name + pin, maximize, close
    await expect(head).not.toContainText(/haiku|agent\/|\d\d:\d\d/)
    expect((await box(head)).height).toBeLessThan(34)
    // compact, wider than tall (the group lays the card out at the default size)
    const b = await box(card)
    expect(b.width / b.height).toBeGreaterThan(1.3)
    expect(b.width / b.height).toBeLessThan(1.7)
    // the terminal fills the body: no padding band between the xterm and its host
    const body = await box(card.getByTestId('terminal-body'))
    const screen = await box(card.locator('.xterm-screen'))
    expect(screen.x - body.x).toBeLessThan(2)

    // details by click: role, model, branch, elapsed, last message
    const nameBtn = head.getByRole('button', { name, exact: true })
    await expect(nameBtn).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(nameBtn).toHaveAttribute('aria-expanded', 'false')
    await nameBtn.click()
    const dlg = page.getByRole('dialog', { name: `Details for ${name}` })
    await expect(nameBtn).toHaveAttribute('aria-expanded', 'true')
    await expect(dlg).toContainText('builder')
    await expect(dlg).toContainText('haiku')
    await expect(dlg).toContainText('agent/builder-1')
    await expect(dlg).toContainText(/\d\d:\d\d/)
    await expect(dlg.getByTestId('last-source')).toHaveAttribute('data-source', 'scrape')
    // Esc closes and gives the focus back to the name; Enter opens it again
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
    await expect(nameBtn).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dlg).toBeVisible()

    // a prompt sent from the popover is one submission (bracketed paste)
    const area = dlg.getByRole('textbox', { name: `Prompt for ${name}` })
    await expect(area).toBeFocused()
    await area.fill('first\nsecond')
    await area.press('Control+Enter')
    await expect(dlg).toHaveCount(0)
    await expect(card.getByTestId('terminal-body')).toContainText('SUBMITTED 1')
    await expect.poll(() => r.runs().length).toBe(1)
    const pid = r.runs()[0]!.pid
    await expect.poll(() => readFileSync(join(r.logs, `${pid}.subs`), 'utf8').trim().split('\n').length).toBe(1)
    expect(JSON.parse(readFileSync(join(r.logs, `${pid}.subs`), 'utf8').trim()) as string).toBe(`${START}first\nsecond${END}`)
    await expect(card).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('console card: same header, pin blocks dragging, maximize and restore keep the terminal, selected border', async () => {
  test.setTimeout(60_000)
  const { app, page, errors } = await launch()
  try {
    await newConsole(page, 1)
    const card = page.getByTestId('terminal-node').nth(0)
    const head = card.locator('.card-head')
    await expect(head).toContainText('console-1')
    await expect(head.getByTestId('role-tag')).toHaveText('shell')
    await expect(head.getByTestId('status-word')).toHaveText('running')
    const b0 = await box(card)
    expect(b0.width / b0.height).toBeGreaterThan(1.3)
    expect(Math.round(b0.width)).toBeLessThanOrEqual(420)

    // selected: lighter border
    await expect(card).not.toHaveClass(/is-selected/)
    await head.click({ position: { x: 180, y: 12 } })
    await expect(card).toHaveClass(/is-selected/)

    const dragBy = async (dx: number) => {
      const h = await box(head)
      await page.mouse.move(h.x + 180, h.y + 12)
      await page.mouse.down()
      await page.mouse.move(h.x + 180 + dx, h.y + 12 + 40, { steps: 6 })
      await page.mouse.up()
    }
    const pin = head.getByRole('button', { name: 'Pin console-1' })
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await pin.click()
    await expect(head.getByRole('button', { name: 'Unpin console-1' })).toHaveAttribute('aria-pressed', 'true')
    // the node's own position in the flow (a drag on a locked card may still pan the canvas, which moves the screen box but not this)
    const flowPos = () => card.locator('xpath=ancestor::div[@data-id]').evaluate((el) => (el as HTMLElement).style.transform)
    const pinnedAt = await flowPos()
    await dragBy(120)
    expect(await flowPos()).toBe(pinnedAt)
    await head.getByRole('button', { name: 'Unpin console-1' }).click()
    await dragBy(120)
    expect(await flowPos()).not.toBe(pinnedAt)

    // maximize: covers the canvas, the same terminal (not remounted) keeps its output; Esc restores
    await typeIn(page, 0, 'echo MARK_ONE')
    await expect(card.getByTestId('terminal-body')).toContainText('MARK_ONE')
    await card.locator('.xterm').evaluate((el) => el.setAttribute('data-keep', '1'))
    const before = await box(card)
    await head.getByRole('button', { name: 'Maximize console-1' }).click()
    await expect(card).toHaveAttribute('data-maximized', 'true')
    await expect.poll(async () => (await box(card)).width).toBeGreaterThan(1000)
    expect((await box(card)).height).toBeGreaterThan(600)
    await expect(card.getByTestId('terminal-body')).toContainText('MARK_ONE')
    await expect(card.locator('.xterm[data-keep="1"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(card).not.toHaveAttribute('data-maximized', 'true')
    await expect.poll(async () => Math.round((await box(card)).width)).toBe(Math.round(before.width))
    await expect(card.getByTestId('terminal-body')).toContainText('MARK_ONE')
    await expect(card.locator('.xterm[data-keep="1"]')).toHaveCount(1)
    // the same button restores too
    await head.getByRole('button', { name: 'Maximize console-1' }).click()
    await head.getByRole('button', { name: 'Restore console-1' }).click()
    await expect(card).not.toHaveAttribute('data-maximized', 'true')
    // zoomed out, the maximized card still fills the screen at scale 1 (readable text, sane column count)
    await page.mouse.move(700, 760)
    await page.mouse.wheel(0, 400)
    const zoom = () => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
    await expect.poll(zoom).toBeLessThan(0.8)
    await head.getByRole('button', { name: 'Maximize console-1' }).click()
    await expect.poll(async () => (await box(card)).width).toBeGreaterThan(1000)
    expect((await box(card)).height).toBeGreaterThan(600)
    const netScale = await card.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth)
    expect(netScale).toBeCloseTo(1, 2)
    await expect(card.locator('.xterm[data-keep="1"]')).toHaveCount(1)
    await head.getByRole('button', { name: 'Restore console-1' }).click()
    await expect(card).not.toHaveAttribute('data-maximized', 'true')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('closing a live agent asks first; keeping it leaves it running, confirming closes and cleans up', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_CLOSE: 'no,yes' })
  try {
    await openRepo(page)
    await spawnAgent(page, 'builder', 'haiku', 1)
    const card = page.getByTestId('agent-node').nth(0)
    await expect(card.getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await expect.poll(() => r.runs().length).toBe(1)
    const run = r.runs()[0]!
    const name = (await card.getAttribute('data-name'))!
    await card.getByRole('button', { name: `Close ${name}` }).click() // answered "no"
    await page.waitForTimeout(800)
    await expect(card).toHaveCount(1)
    expect(alive(run.pid)).toBe(true)
    expect(r.worktreeCount()).toBe(2)
    await expect(page.getByTestId('live-badge')).toHaveText(/^1 live/)
    await card.getByRole('button', { name: `Close ${name}` }).click() // answered "yes"
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expectGone(run.pid)
    await expect.poll(() => r.agentBranches()).toEqual([])
    expect(r.worktreeCount()).toBe(1)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('closing the window with a live agent asks first; keeping it leaves everything running', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_LEAVE: 'no' })
  try {
    await openRepo(page)
    await spawnAgent(page, 'builder', 'haiku', 1)
    const card = page.getByTestId('agent-node').nth(0)
    await expect(card.getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await expect.poll(() => r.runs().length).toBe(1)
    const run = r.runs()[0]!
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()) // answered "no"
    await page.waitForTimeout(800)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect(card).toHaveCount(1)
    expect(alive(run.pid)).toBe(true)
    // with nothing live left, leaving asks nothing
    const name = (await card.getAttribute('data-name'))!
    await card.getByRole('button', { name: `Close ${name}` }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expectGone(run.pid)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('closing asks nothing for an exited agent or an idle shell, and asks for a shell running a program', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page, tmp, errors } = await launch({ ...r.env, NODSHELL_TEST_CLOSE: 'no' }) // every question is answered "no"
  try {
    await openRepo(page)
    await spawnAgent(page, 'builder', 'haiku', 1)
    const card = page.getByTestId('agent-node').nth(0)
    await expect(card).toHaveAttribute('data-state', 'idle')
    const name = (await card.getAttribute('data-name'))!
    await card.getByRole('button', { name, exact: true }).click()
    const area = page.getByRole('textbox', { name: `Prompt for ${name}` })
    await area.fill('EXITNOW please')
    await area.press('Control+Enter')
    await expect(card).toHaveAttribute('data-state', 'exited', { timeout: 10_000 })
    await expect(card.getByTestId('status-word')).toHaveText('exited')
    await card.getByRole('button', { name: `Close ${name}` }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expect.poll(() => r.agentBranches()).toEqual([])

    // an idle shell closes directly
    await newConsole(page, 1)
    await page.getByRole('button', { name: 'Close console-1' }).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(0)

    // a shell with a program running asks (answered "no"): it stays and the program lives
    await newConsole(page, 1)
    await typeIn(page, 0, `sh -c 'echo $$ > ${tmp}/child; exec sleep 1000'`)
    await expect.poll(() => { try { return readFileSync(join(tmp, 'child'), 'utf8').trim() } catch { return '' } }).not.toBe('')
    const child = Number(readFileSync(join(tmp, 'child'), 'utf8').trim())
    await page.getByRole('button', { name: 'Close console-2' }).click()
    await page.waitForTimeout(800)
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    expect(alive(child)).toBe(true)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('screenshot: a group of two agents, a console, one card selected', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page } = await launch(r.env)
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await typeIn(page, 0, 'echo "hello from the console"; ls --color=auto /etc | head -n 5')
    await spawnPreset(page, 'Frontend', 2)
    const cards = page.getByTestId('agent-node')
    await expect(cards).toHaveCount(2)
    for (const i of [0, 1]) await expect(cards.nth(i).getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'idle')
    // one agent mid-turn, so the orange "running" pill shows
    const name0 = (await cards.nth(0).getAttribute('data-name'))!
    await cards.nth(0).getByRole('button', { name: name0, exact: true }).click()
    await page.getByRole('textbox', { name: `Prompt for ${name0}` }).fill('PERMISSION please')
    await page.keyboard.press('Control+Enter')
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'working')
    await page.getByTestId('terminal-node').locator('.card-head').click({ position: { x: 180, y: 12 } })
    await page.mouse.move(700, 880)
    await page.waitForTimeout(600)
    await page.screenshot({ path: test.info().outputPath('c2.png') })
  } finally {
    await app.close()
  }
})

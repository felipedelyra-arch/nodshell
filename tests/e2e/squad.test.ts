import { expect, test, type Locator, type Page } from '@playwright/test'
import { cleanupTemp, expectGone, launch, newConsole } from './helpers'
import { openRepo, setupRepo, spawnPreset } from './repo'

test.afterEach(cleanupTemp)

const box = async (l: Locator) => (await l.boundingBox())!

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

const squadItem = (page: Page) => page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ })

async function createSquad(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Presets', exact: true }).click()
  await squadItem(page).click()
}

test('squad: layout, live Orchestrator list, expand and restore, stacking, no room refused, close', async () => {
  test.setTimeout(300_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await createSquad(page)
    await expect(page.getByRole('dialog', { name: 'Presets' })).toHaveCount(0) // one touch, then the dialog closes
    const orch = page.getByTestId('orchestrator-node')
    await expect(orch).toHaveCount(1)
    await expect(page.getByTestId('group-node')).toHaveCount(4)
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await expect.poll(() => r.runs().length, { timeout: 60_000 }).toBe(9)
    expect(r.agentBranches().sort()).toEqual(['agent/backend-1', 'agent/backend-2', 'agent/frontend-1', 'agent/frontend-2', 'agent/orchestrator-1', 'agent/reviewer-1', 'agent/reviewer-2', 'agent/tester-1', 'agent/tester-2'])
    for (const name of ['Frontend', 'Backend', 'Testers', 'Reviewers']) await expect(page.locator(`[data-testid=group-node][data-name="${name}"]`).getByTestId('group-label')).toHaveText(`${name.toUpperCase()} 2 · 2 running`)

    // layout: Frontend over Testers on the left, Backend over Reviewers on the right, the Orchestrator between columns and rows
    await page.waitForTimeout(400) // the canvas fits itself to the new nodes
    const frame = (name: string) => box(page.locator(`[data-testid=group-node][data-name="${name}"] .group-frame`))
    const [fe, be, te, re, o] = [await frame('Frontend'), await frame('Backend'), await frame('Testers'), await frame('Reviewers'), await box(orch)]
    expect(Math.abs(fe.x - te.x)).toBeLessThan(2)
    expect(Math.abs(be.x - re.x)).toBeLessThan(2)
    expect(te.y).toBeGreaterThan(fe.y + fe.height)
    expect(re.y).toBeGreaterThan(be.y + be.height)
    expect(o.x).toBeGreaterThan(fe.x + fe.width)
    expect(o.x + o.width).toBeLessThan(be.x)
    expect(o.y + o.height / 2).toBeGreaterThan(fe.y + fe.height / 2)
    expect(o.y + o.height / 2).toBeLessThan(te.y + te.height / 2)
    expect(o.height).toBeGreaterThan(o.width) // narrow and tall
    // the panel hugs its content: no scrolling, no empty band above the footer
    expect(await orch.locator('.orch-list').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
    const lastRow = await box(orch.getByTestId('orch-row').last())
    expect((await box(orch.locator('.orch-foot'))).y - (lastRow.y + lastRow.height)).toBeLessThan(12)
    expect(o.height).toBeLessThan(te.y + te.height - fe.y)
    expect(o.width / fe.width).toBeGreaterThan(0.25)
    expect(o.width / fe.width).toBeLessThan(0.45)

    // the panel: header, summary, sections in order, one row per agent with role and CLI, live status
    await expect(orch.getByText('Orchestrator', { exact: true })).toBeVisible()
    await expect(orch.getByTestId('orch-tasks')).toHaveText('0/0')
    await expect(orch.getByTestId('orch-summary')).toHaveText('8 agents · 4 groups')
    await expect(orch.getByRole('button', { name: 'Connect' })).not.toHaveAttribute('aria-disabled') // works since F5 (see flow.test)
    await expect(orch.getByTestId('orch-section-name')).toHaveText(['BACKEND', 'REVIEWERS', 'FRONTEND', 'TESTERS'])
    await expect(orch.getByTestId('orch-section')).toHaveText([/BACKEND\s*2/, /REVIEWERS\s*2/, /FRONTEND\s*2/, /TESTERS\s*2/])
    const rows = orch.getByTestId('orch-row')
    await expect(rows).toHaveCount(8)
    await expect(rows.nth(0)).toContainText('Backend · Claude')
    await expect(rows.nth(6)).toContainText('Tester · Claude')
    const feNames = await page.locator('[data-testid=agent-node]').evaluateAll((els) => els.filter((e) => e.querySelector('[data-testid=role-tag]')?.textContent === 'frontend').map((e) => e.getAttribute('data-name')!))
    expect(feNames).toHaveLength(2)
    await expect(orch.getByTestId('orch-section').nth(2).getByTestId('orch-row')).toHaveCount(2)
    for (const n of feNames) await expect(orch.locator(`[data-testid=orch-row][data-name="${n}"]`)).toBeVisible()
    await expect(orch.getByRole('combobox', { name: 'Command the squad' })).toHaveAttribute('placeholder', 'Command 8 agents · @ to direct…')
    // F7: the field works; Send waits for text, and the microphone for whisper.cpp (not installed under the test's HOME)
    for (const name of ['Send command', 'Dictate command']) await expect(orch.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true')
    await expect(orch.getByRole('combobox', { name: 'Command the squad' })).toBeEditable()
    await expect(orch.getByTestId('orch-row-status')).toHaveText(Array(8).fill('resting'))
    // the Orchestrator's state shows only on its header dot (named for assistive tech) and in the expand button's name
    await expect(orch.getByRole('img', { name: 'Orchestrator resting' })).toHaveClass(/st-idle/)
    await expect(orch.getByRole('button', { name: 'Open Orchestrator terminal (resting)' })).toBeVisible()
    await expect(orch.locator('.status-pill:not([data-testid=orch-row-status])')).toHaveCount(0)

    // four edges, one per group, from the side facing the Orchestrator, each with its dot; the paths are hidden from assistive tech, the dots are buttons
    const edges = page.locator('.react-flow__edge-flow')
    await expect(edges).toHaveCount(4)
    for (const e of await edges.all()) await expect(e).toHaveAttribute('aria-hidden', 'true')
    const dots = await Promise.all((await page.getByTestId('flow-edge-dot').all()).map(box))
    expect(dots).toHaveLength(4)
    const left = dots.filter((d) => d.x > fe.x + fe.width && d.x < o.x).sort((a, b) => a.y - b.y)
    const right = dots.filter((d) => d.x > o.x + o.width && d.x < be.x).sort((a, b) => a.y - b.y)
    expect([left.length, right.length]).toEqual([2, 2])
    // each edge leaves its group and enters the Orchestrator: the upper row higher than the lower one
    const ends = await page.getByTestId('flow-edge').evaluateAll((ps) => ps.map((p) => { const path = p as SVGPathElement; const end = path.getPointAtLength(path.getTotalLength()); const b = new DOMPoint(end.x, end.y).matrixTransform(path.getScreenCTM()!); return `${Math.round(b.x)},${Math.round(b.y)}` })) // in screen px, like the boxes
    expect(new Set(ends).size).toBe(4) // four distinct arrival points
    const arrivals = [...new Set(ends.map((e) => Number(e.split(',')[1])))].sort((a, b) => a - b)
    expect(arrivals).toHaveLength(2)
    expect(arrivals[0]!).toBeGreaterThan(o.y)
    expect(arrivals[1]!).toBeLessThan(o.y + o.height)
    expect(left[0]!.y).toBeLessThan(left[1]!.y)

    await page.screenshot({ path: test.info().outputPath('c4.png') })

    // the footer's tips open upwards, inside the panel, and show on focus
    const field = orch.getByRole('button', { name: 'Dictate command' })
    await field.hover()
    const tip = () => field.evaluate((el) => { const s = getComputedStyle(el, '::after'); return { opacity: s.opacity, top: s.top, bottom: s.bottom, content: s.content } })
    await expect.poll(async () => (await tip()).opacity).toBe('1')
    const shown = await tip()
    expect(shown.content).toContain('"Voice needs whisper.cpp in ~/.local/share/whisper.cpp"')
    expect(parseFloat(shown.top)).toBeLessThan(0) // above the field
    await field.blur()

    // a member works: its badge follows the hooks live
    const zoe = feNames[0]!
    const row = orch.locator(`[data-testid=orch-row][data-name="${zoe}"]`).getByTestId('orch-row-status')
    await page.locator(`[data-testid=agent-node][data-name="${zoe}"]`).getByTestId('terminal-body').click()
    await page.keyboard.type('do some work')
    await page.keyboard.press('Enter')
    await expect(row).toHaveText('running')
    await expect(row).toHaveClass(/status-pill-on/)
    await expect(row).toHaveText('resting', { timeout: 10_000 })

    // expand: the Orchestrator's own terminal covers the canvas; Esc outside the terminal restores; it is never remounted
    const lead = page.getByTestId('agent-node').filter({ has: page.getByTestId('role-tag').filter({ hasText: /^orchestrator$/ }) })
    await expect(lead).toBeHidden()
    const leadName = (await lead.getAttribute('data-name'))!
    const expand = orch.getByRole('button', { name: /^Open Orchestrator terminal/ })
    await expand.click()
    await expect(lead).toHaveAttribute('data-maximized', 'true')
    await expect(lead).toBeVisible()
    await expect.poll(async () => (await box(lead)).width).toBeGreaterThan(1000)
    await expect(lead.getByTestId('terminal-body')).toContainText('FAKE CLAUDE READY')
    await lead.locator('.xterm').evaluate((el) => el.setAttribute('data-keep', '1'))
    await lead.getByTestId('terminal-body').click()
    await page.keyboard.type('plan it')
    await page.keyboard.press('Enter')
    await expect(lead.getByTestId('terminal-body')).toContainText('SUBMITTED 1')
    await page.keyboard.press('Escape') // inside the terminal it belongs to the CLI
    await expect(lead).toHaveAttribute('data-maximized', 'true')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(lead).not.toHaveAttribute('data-maximized', 'true')
    await expect(lead).toBeHidden()
    await expand.click()
    await expect(lead).toBeVisible()
    await expect(lead.getByTestId('terminal-body')).toContainText('SUBMITTED 1')
    await expect(lead.locator('.xterm[data-keep="1"]')).toHaveCount(1)
    await lead.getByRole('button', { name: `Restore ${leadName}` }).click()
    await expect(lead).toBeHidden()

    // closing a member: the counts drop
    await page.getByRole('button', { name: `Close ${feNames[1]}` }).click()
    await expect(orch.getByTestId('orch-summary')).toHaveText('7 agents · 4 groups')
    await expect(orch.getByTestId('orch-section').nth(2)).toHaveText(/FRONTEND\s*1/)
    await expect(rows).toHaveCount(7)
    await expect(orch.getByRole('combobox', { name: 'Command the squad' })).toHaveAttribute('placeholder', 'Command 7 agents · @ to direct…')

    // a second squad goes below the first, groups and Orchestrator included
    await createSquad(page)
    await expect(orch).toHaveCount(2)
    await expect(page.getByTestId('group-node')).toHaveCount(8)
    await expect.poll(() => r.runs().length, { timeout: 60_000 }).toBe(18)
    await page.waitForTimeout(400)
    const frames = (await Promise.all((await page.locator('.group-frame').all()).map(box))).sort((a, b) => a.y - b.y)
    const orchs = (await Promise.all((await orch.all()).map(box))).sort((a, b) => a.y - b.y)
    const firstBottom = Math.max(...frames.slice(0, 4).map((f) => f.y + f.height), orchs[0]!.y + orchs[0]!.height)
    for (const f of frames.slice(4)) expect(f.y).toBeGreaterThan(firstBottom)
    expect(orchs[1]!.y).toBeGreaterThan(firstBottom)
    expect(Math.abs(orchs[1]!.x - orchs[0]!.x)).toBeLessThan(2)

    // no room for nine: refused with the reason, nothing created
    await createSquad(page)
    await expect(page.getByTestId('layout-error')).toHaveText('Only 3 of 20 terminals are free, cannot start 9.')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(r.runs()).toHaveLength(18)
    await expect(orch).toHaveCount(2)
    await expect(page.getByTestId('group-node')).toHaveCount(8)
    await expect(page.getByTestId('live-badge')).toHaveText(/^17 live/)

    await expect(edges).toHaveCount(8)

    // closing an Orchestrator removes its node and its four edges; its groups stay as plain groups
    const leadPid = r.runs().find((x) => x.cwd.endsWith('orchestrator-1'))!.pid
    await orch.first().getByRole('button', { name: 'Close Orchestrator' }).click()
    await expect(orch).toHaveCount(1)
    await expect(page.getByTestId('group-node')).toHaveCount(8)
    await expect(edges).toHaveCount(4)
    await expectGone(leadPid)
    // ungrouping a group of the remaining squad removes its edge
    await page.getByRole('button', { name: 'Ungroup BACKEND' }).last().click()
    await expect(page.getByTestId('group-node')).toHaveCount(7)
    await expect(edges).toHaveCount(3)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('without a squad: consoles, Spawn N and Group work as before; the Squad layout needs a repository', async () => {
  test.setTimeout(60_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await expect(squadItem(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(squadItem(page)).toHaveAttribute('data-tip', 'Open a repository first')
    await expect(squadItem(page)).toHaveAccessibleDescription(/Orchestrator \+ 4 groups of 2.*Open a repository first/)
    await squadItem(page).dispatchEvent('click') // aria-disabled: Playwright would refuse to click
    await page.waitForTimeout(300)
    expect(r.runs()).toHaveLength(0)
    await expect(page.getByRole('dialog', { name: 'Presets' })).toBeVisible()
    await page.keyboard.press('Escape')

    await newConsole(page, 1)
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.getByTestId('agent-node')).toHaveCount(2)
    await expect(page.getByTestId('group-label')).toHaveText('FRONTEND 2 · 2 running')
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await expect(page.getByTestId('orchestrator-node')).toHaveCount(0)
    await expect(page.getByTestId('live-badge')).toHaveText(/^2 live/)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

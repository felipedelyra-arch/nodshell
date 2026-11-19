import { expect, test, type Page } from '@playwright/test'
import { alive, cleanupTemp, launch } from './helpers'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { openRepo, setupRepo } from './repo'

test.afterEach(cleanupTemp)

const zoom = (page: Page) => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)

/** A point of the board where the bare pane is under the cursor (a drag there pans). */
const emptySpot = (page: Page) =>
  page.evaluate(() => {
    for (let y = 120; y < innerHeight - 160; y += 20) for (let x = 90; x < innerWidth - 20; x += 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
    return null
  })

/** Every visible agent card that is on screen shows the banner (xterm paints only what intersects the viewport, so off-screen cards are not asked to). */
async function expectPainted(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const bare = [...document.querySelectorAll('[data-testid=agent-node]')].filter((c) => {
          const b = c.getBoundingClientRect()
          const body = c.querySelector('[data-testid=terminal-body]') as HTMLElement
          const on = b.width > 0 && body.offsetWidth > 0 && getComputedStyle(c).visibility !== 'hidden' && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight
          return on && !(c.querySelector('.xterm-rows')?.textContent ?? '').includes('FAKE CLAUDE READY')
        })
        return bare.length
      }), { timeout: 30_000 })
    .toBe(0)
  await expect(page.locator('[data-testid=agent-node] .xterm-rows', { hasText: 'FAKE CLAUDE READY' }).first()).toBeVisible()
}

/** Wheel over the middle of the board until the zoom passes the target (down: out, up: in). */
async function zoomTo(page: Page, target: number, dir: 'out' | 'in'): Promise<void> {
  const spot = (await emptySpot(page))! // a card under the cursor would keep the wheel for its terminal
  await page.mouse.move(spot.x, spot.y)
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, dir === 'out' ? 200 : -200)
      const z = await zoom(page)
      return dir === 'out' ? z < target : z > target
    }, { timeout: 30_000 })
    .toBe(true)
}

test('20 terminals (two squads and two consoles) stay alive and the board stays responsive; zoomed out the cards show a summary instead of the terminal; the 21st is refused', async () => {
  test.setTimeout(420_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    for (let n = 1; n <= 2; n++) {
      await page.getByRole('button', { name: 'Presets', exact: true }).click()
      await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
      await expect(page.getByTestId('agent-node')).toHaveCount(9 * n, { timeout: 60_000 })
      await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9 * n, { timeout: 90_000 })
    }
    for (let n = 1; n <= 2; n++) {
      await page.getByRole('button', { name: 'New console' }).click()
      await expect(page.getByTestId('terminal-node')).toHaveCount(n)
    }
    await expect(page.getByTestId('orchestrator-node')).toHaveCount(2)
    const pids = r.runs().map((x) => x.pid)
    expect(pids).toHaveLength(18)
    await expect(page.getByTestId('live-badge')).toHaveText(/^18 live/)

    // the 21st (and the 3rd console: 18 agents + 2 consoles = 20) is refused with the limit in the message
    await page.getByRole('button', { name: 'New console' }).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(2)
    await expect(page.getByText('Terminal limit reached (20)')).toBeVisible()
    expect(await page.evaluate(() => window.api.invoke('pty:spawn', { cols: 80, rows: 24 }).then(() => 'started', (e: Error) => e.message))).toMatch(/Terminal limit reached \(20\)/)

    // the xterm instances are never recreated by a zoom change (modes and parser state live in them) and the change writes nothing to a PTY
    await page.evaluate(() => document.querySelectorAll('.xterm').forEach((el) => el.setAttribute('data-keep', '1')))
    const stdinSize = () => pids.map((pid) => { try { return statSync(join(r.logs, `${pid}.stdin`)).size } catch { return 0 } })
    const inputBefore = stdinSize()
    // fitted to the whole board the zoom is low: previews, no xterm
    await page.screenshot({ path: test.info().outputPath('f10-overview.png') })
    await expect(page.locator('.xterm:visible')).toHaveCount(0)
    await zoomTo(page, 0.9, 'in')
    await expect(page.locator('.xterm:visible')).toHaveCount(18) // the two Orchestrator terminals only show maximized
    await expect(page.locator('.xterm')).toHaveCount(20)
    await expectPainted(page)

    // pan with every terminal mounted: rAF intervals during a drag on bare canvas
    const spot = await emptySpot(page)
    expect(spot).not.toBeNull()
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean }
      w.__frames = []
      w.__stop = false
      let last = performance.now()
      const tick = (t: number) => {
        w.__frames.push(t - last)
        last = t
        if (!w.__stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.mouse.move(spot!.x, spot!.y)
    await page.mouse.down()
    for (let i = 1; i <= 60; i++) await page.mouse.move(spot!.x - i * 2, spot!.y + i)
    await page.mouse.up()
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean }
      w.__stop = true
      return w.__frames.slice(1)
    })
    const sorted = [...frames].sort((a, c) => a - c)
    const median = sorted[Math.floor(sorted.length / 2)]!
    test.info().annotations.push({ type: 'pan', description: `${frames.length} frames, median ${median.toFixed(1)} ms` })
    expect(frames.length).toBeGreaterThan(10)
    expect(median).toBeLessThan(50)

    // zoomed out: previews only, no xterm; the processes never notice
    await zoomTo(page, 0.45, 'out')
    await expect(page.locator('.xterm:visible')).toHaveCount(0)
    await expect(page.getByTestId('terminal-preview')).toHaveCount(20)
    await expect(page.locator('[data-testid=agent-node] [data-testid=terminal-preview]', { hasText: 'FAKE CLAUDE READY' })).toHaveCount(18, { timeout: 10_000 })
    await zoomTo(page, 0.3, 'out')
    await page.screenshot({ path: test.info().outputPath('f10-lowzoom.png') })
    for (const pid of pids) expect(alive(pid)).toBe(true)

    // back in: the terminals come back with their recent content
    await zoomTo(page, 0.9, 'in')
    await expect(page.locator('.xterm:visible')).toHaveCount(18) // the two Orchestrator terminals only show maximized
    await expect(page.locator('.xterm')).toHaveCount(20)
    await expect(page.getByTestId('terminal-preview')).toHaveCount(0)
    await expectPainted(page)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(18)
    await expect(page.locator('.xterm[data-keep]')).toHaveCount(20) // the very same instances came back
    await expect(page.locator('.xterm:not([data-keep])')).toHaveCount(0)
    expect(stdinSize()).toEqual(inputBefore) // not one byte (no DA/DSR reply, no stray input) reached an agent
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('a Small squad that fits the window shows a legible summary per card; selecting one brings its terminal back; zooming in restores the terminals', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Small squad/ }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(5, { timeout: 60_000 })
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(5, { timeout: 90_000 })
    await page.getByRole('button', { name: 'New console' }).click() // a free card: cards inside a group cannot be selected
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await page.evaluate(() => document.querySelectorAll('.xterm').forEach((el) => el.setAttribute('data-keep', '1')))
    const pids = r.runs().map((x) => x.pid)
    const stdinSize = () => pids.map((pid) => { try { return statSync(join(r.logs, `${pid}.stdin`)).size } catch { return 0 } })
    const inputBefore = stdinSize()
    if ((await zoom(page)) >= 0.8) await zoomTo(page, 0.6, 'out') // the fitted board is already below ~0.82 with a full squad; make sure here
    const cards = page.getByTestId('agent-node')
    await expect(page.getByTestId('terminal-preview')).toHaveCount(6)
    await expect(page.locator('.xterm:visible')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('squad-summary.png') })
    for (let i = 0; i < 5; i++) {
      const c = cards.nth(i)
      const name = (await c.getAttribute('data-name'))!
      const sum = c.getByTestId('terminal-preview')
      await expect(sum.getByTestId('summary-name')).toHaveText(name)
      await expect(sum.getByTestId('summary-status')).toHaveText('resting')
      await expect(sum).toHaveAttribute('aria-label', new RegExp(`^${name}, resting, last output: .*FAKE CLAUDE READY`))
      // on-screen font = computed font-size x the scale the board applies to it
      const px = await sum.evaluate((el) => {
        const out: Record<string, number> = {}
        for (const t of ['summary-name', 'summary-status', 'summary-lines']) {
          const e = el.querySelector(`[data-testid=${t}]`)!
          out[t] = parseFloat(getComputedStyle(e).fontSize) * (e.getBoundingClientRect().height / (e as HTMLElement).offsetHeight)
        }
        return out
      })
      expect(px['summary-name']).toBeGreaterThanOrEqual(13.9)
      expect(px['summary-status']).toBeGreaterThanOrEqual(10.9)
      expect(px['summary-lines']).toBeGreaterThanOrEqual(10.9)
    }
    // a selected card shows its terminal; the others keep the summary
    await page.getByTestId('terminal-node').getByTestId('terminal-preview').click()
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
    await expect(page.getByTestId('terminal-preview')).toHaveCount(5)
    // a grouped card cannot be selected: double-clicking its summary opens it in focus mode, restoring brings the summaries back
    const grouped = cards.first()
    await expect(grouped.getByTestId('terminal-preview')).toHaveAttribute('title', 'Double-click to open')
    await grouped.getByTestId('terminal-preview').dblclick()
    await expect(grouped).toHaveAttribute('data-maximized', 'true')
    await expect(grouped.locator('.xterm:visible')).toHaveCount(1)
    await expect(grouped.getByTestId('terminal-preview')).toHaveCount(0)
    await page.keyboard.press('Control+Shift+F')
    await expect(grouped).not.toHaveAttribute('data-maximized', 'true')
    await expect(grouped.getByTestId('terminal-preview')).toHaveCount(1)
    await expect(page.getByTestId('terminal-preview')).toHaveCount(5)
    // zoomed in past the threshold every terminal is back, the same instances
    await zoomTo(page, 0.9, 'in')
    await expect(page.getByTestId('terminal-preview')).toHaveCount(0)
    await expect(page.locator('.xterm:visible')).toHaveCount(5) // 4 agents and the console; the Orchestrator terminal only shows maximized
    await expect(page.locator('.xterm[data-keep]')).toHaveCount(6)
    await expect(page.locator('.xterm:not([data-keep])')).toHaveCount(0)
    expect(stdinSize()).toEqual(inputBefore)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('a selected card stays an xterm while zoomed out; the limit is set in About, saved in main and refuses new terminals only', async () => {
  const { app, page, errors } = await launch()
  try {
    for (let n = 1; n <= 3; n++) {
      await page.getByRole('button', { name: 'New console' }).click()
      await expect(page.getByTestId('terminal-node')).toHaveCount(n)
    }
    // zoomed out: only the focused (or selected) console keeps its terminal
    await page.getByTestId('terminal-body').first().click()
    await zoomTo(page, 0.45, 'out')
    await expect(page.getByTestId('terminal-preview')).toHaveCount(2)
    await expect(page.locator('.xterm:visible')).toHaveCount(1)
    await page.mouse.click((await emptySpot(page))!.x, (await emptySpot(page))!.y)
    await expect(page.locator('.xterm:visible')).toHaveCount(0)
    await expect(page.getByTestId('terminal-preview')).toHaveCount(3)

    await page.getByRole('button', { name: 'About' }).click()
    const dlg = page.getByRole('dialog', { name: 'About' })
    const field = dlg.getByLabel(/Live terminal limit/)
    await expect(field).toHaveValue('20')
    await field.fill('41')
    await expect(dlg.getByRole('button', { name: 'Save' })).toBeDisabled()
    await field.fill('2')
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(dlg.getByRole('status')).toHaveText('Saved')
    expect(await page.evaluate(() => window.api.invoke('settings:get', undefined))).toEqual({ liveLimit: 2 })
    expect(await page.evaluate(() => window.api.invoke('settings:setLiveLimit', { limit: 99 }).then(() => 'ok', () => 'rejected'))).toBe('rejected')
    await page.keyboard.press('Escape')
    // lowering below the 3 running consoles killed none; only a new one is refused, with the new number
    await expect(page.getByTestId('terminal-preview')).toHaveCount(3)
    await page.getByRole('button', { name: 'New console' }).click()
    await expect(page.getByText('Terminal limit reached (2)')).toBeVisible()
    await expect(page.getByTestId('terminal-node')).toHaveCount(3)

    // the memory figure next to the count
    await expect(page.getByTestId('live-badge')).toHaveText(/^0 live· \d+\.\d GB$/, { timeout: 15_000 })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

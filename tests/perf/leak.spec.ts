// Memory-leak and orphan-process checks. Perf harness: drives the real build; run with `npm run perf -- leak.spec.ts`.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cleanupTemp } from '../e2e/helpers'
import { openRepo, setupRepo } from '../e2e/repo'
import { emptySpot, launch, procs, ptyLeaders, save, sleep, TUI, writeAll } from './support'

test.afterEach(() => cleanupTemp())

const MINUTES = Number(process.env['NODSHELL_LEAK_MINUTES'] ?? 30)
const STEP = Number(process.env['NODSHELL_LEAK_STEP_MIN'] ?? 5)
const launchGc = (extra: Record<string, string> = {}) => launch(extra, ['--js-flags=--expose-gc'])

type Mem = { t: number; main: number; renderer: number; gpu: number; network: number; app: number; pty: number; heap: number | null; gc: boolean }

/** RSS (MB) per Electron process type, app total, PTY trees and the page JS heap, after a forced GC when the page exposes it. */
async function mem(app: ElectronApplication, page: Page, t: number): Promise<Mem> {
  const gc = await page.evaluate(() => typeof (globalThis as { gc?: unknown }).gc === 'function')
  for (let i = 0; i < 2; i++) await page.evaluate(() => (globalThis as { gc?: () => void }).gc?.())
  await sleep(500)
  const heap = await page.evaluate(() => { const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory; return m ? Math.round(m.usedJSHeapSize / 1048576) : null })
  const info = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, name: x.name ?? '', mb: Math.round(x.memory.workingSetSize / 1024) })))
  const sum = (f: (x: (typeof info)[number]) => boolean) => info.filter(f).reduce((n, x) => n + x.mb, 0)
  const leaders = ptyLeaders(app.process().pid!).map((p) => p.pid)
  const pty = Math.round(procs().filter((p) => leaders.includes(p.sid)).reduce((n, p) => n + p.rssKb, 0) / 1024)
  return { t, main: sum((x) => x.type === 'Browser'), renderer: sum((x) => x.type === 'Tab'), gpu: sum((x) => x.type === 'GPU'), network: sum((x) => x.type === 'Utility' && /network/i.test(x.name)), app: sum(() => true), pty, heap, gc }
}

const openConsoles = async (page: Page, n: number) => {
  for (let i = 1; i <= n; i++) { await page.getByRole('button', { name: 'New console' }).click(); await expect(page.getByTestId('terminal-node')).toHaveCount(i) }
  await sleep(1500)
}
const closeAll = async (page: Page) => {
  { const e = await emptySpot(page); if (e) await page.mouse.click(e.x, e.y) }
  await page.getByRole('button', { name: /^Close all$/ }).click()
  await expect(page.getByTestId('terminal-node')).toHaveCount(0, { timeout: 15000 })
  await sleep(1500)
}

test('leak 30 min', async () => {
  test.setTimeout((MINUTES + 6) * 60_000)
  const { app, page } = await launchGc()
  try {
    await openConsoles(page, 9)
    await writeAll(page, TUI)
    await sleep(3000)
    const rows: Mem[] = []
    for (let m = 0; m <= MINUTES; m += STEP) {
      if (m > 0) await sleep(STEP * 60_000)
      rows.push(await mem(app, page, m))
      console.log(`min ${m}: ${JSON.stringify(rows[rows.length - 1])}`)
    }
    console.table(rows)
    const ref = rows[1] ?? rows[0]!
    const last = rows[rows.length - 1]!
    const growth: Record<string, { refMb: number; lastMb: number; deltaMb: number; pct: number }> = {}
    for (const k of ['main', 'renderer', 'gpu', 'network'] as const) {
      const d = last[k] - ref[k]
      growth[k] = { refMb: ref[k], lastMb: last[k], deltaMb: d, pct: ref[k] ? Math.round((d / ref[k]) * 1000) / 10 : 0 }
    }
    const rend = rows.map((r) => r.renderer)
    // shortcut: a short smoke run (<5 samples) is too few points for a trend
    const strictlyUp = rows.length >= 5 && rend.every((v, i) => i === 0 || v > rend[i - 1]!)
    save('leak30', { minutes: MINUTES, stepMin: STEP, gcExposed: rows.every((r) => r.gc), rows, growth, rendererStrictlyIncreasing: strictlyUp })
    for (const [k, g] of Object.entries(growth)) expect(g.pct > 10 && g.deltaMb > 25, `${k} grew ${g.deltaMb} MB (${g.pct}%) since the reference sample`).toBe(false)
    expect(strictlyUp, `renderer RSS strictly increasing: ${rend.join(', ')}`).toBe(false)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('open/close cycles', async () => {
  test.setTimeout(600_000)
  const { app, page } = await launchGc()
  try {
    const rows: Mem[] = []
    for (let c = 1; c <= 6; c++) {
      await openConsoles(page, 9)
      await writeAll(page, 'yes\r')
      await sleep(4000)
      await writeAll(page, '\x03')
      await sleep(500)
      await closeAll(page)
      rows.push(await mem(app, page, c))
    }
    console.table(rows)
    const d = (k: 'renderer' | 'main' | 'heap') => (rows[5]![k] ?? 0) - (rows[1]![k] ?? 0)
    save('cycles', { gcExposed: rows.every((r) => r.gc), rows, cycle6MinusCycle2: { renderer: d('renderer'), main: d('main'), heap: d('heap') } })
    expect(d('renderer'), 'renderer RSS after cycle 6 vs cycle 2 (MB)').toBeLessThanOrEqual(20)
    expect(d('main'), 'main RSS after cycle 6 vs cycle 2 (MB)').toBeLessThanOrEqual(20)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('no orphans after Close all with a squad', async () => {
  test.setTimeout(300_000)
  const repo = setupRepo()
  const { app, page } = await launch(repo.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 120_000 })
    await page.keyboard.press('Escape')
    await sleep(2000)
    const leaders = ptyLeaders(app.process().pid!).map((p) => p.pid)
    const before = procs().filter((p) => leaders.includes(p.sid))
    await closeAll(page)
    await expect(page.locator('[data-testid=agent-node]')).toHaveCount(0, { timeout: 15000 })
    await sleep(3000)
    const alive = procs()
    const survivors = alive.filter((p) => leaders.includes(p.pid) || leaders.includes(p.sid)).map((p) => `${p.comm}:${p.pid}`)
    save('orphans', { leadersBefore: leaders.length, procsBefore: before.length, comms: [...new Set(before.map((p) => p.comm))], survivors })
    expect(leaders.length).toBe(9)
    expect(survivors).toEqual([])
  } finally {
    await app.close().catch(() => undefined)
  }
})

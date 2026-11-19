// Baseline measurements for docs/AUDIT/NODSHELL-UX.md. Perf harness: drives the real build (WebGL renderer); run with `npm run perf`.
import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTemp } from '../e2e/helpers'
import { openRepo, setupRepo } from '../e2e/repo'
import { emptySpot, launch, OUT, ptyLeaders, procs, sample, save, sleep, TUI, writeAll } from './support'

const SHOTS = join(OUT, 'shots')
mkdirSync(SHOTS, { recursive: true })
test.afterEach(() => cleanupTemp())

const fpsStart = (page: Page) => page.evaluate(() => { const f = (window as unknown as { __f: { t: number[]; on: boolean } }).__f; f.t = []; f.on = true })
const fpsStop = (page: Page) =>
  page.evaluate(() => {
    const f = (window as unknown as { __f: { t: number[]; on: boolean } }).__f
    f.on = false
    const d = f.t.slice(1).map((t, i) => t - f.t[i]!).sort((a, b) => a - b)
    if (d.length === 0) return { fps: 0, p95ms: 0, maxms: 0, frames: 0 }
    const total = f.t[f.t.length - 1]! - f.t[0]!
    return { fps: Math.round((d.length / total) * 10000) / 10, p95ms: Math.round(d[Math.floor(d.length * 0.95)]!), maxms: Math.round(d[d.length - 1]!), frames: d.length }
  })


async function panFps(page: Page) {
  const s = await emptySpot(page)
  if (!s) return null
  await page.mouse.move(s.x, s.y)
  await page.mouse.down()
  await fpsStart(page)
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < 3000) { i++; await page.mouse.move(s.x + Math.sin(i / 12) * 220, s.y + Math.cos(i / 17) * 90); await sleep(6) }
  const r = await fpsStop(page)
  await page.mouse.move(s.x, s.y)
  await page.mouse.up()
  return r
}
async function zoomFps(page: Page) {
  const s = await emptySpot(page)
  if (!s) return null
  await page.mouse.move(s.x, s.y)
  await fpsStart(page)
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < 3000) { i++; await page.mouse.wheel(0, Math.floor(i / 14) % 2 === 0 ? -40 : 40); await sleep(8) }
  const r = await fpsStop(page)
  await sleep(400)
  return r
}
const zoomNow = (page: Page) => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
const ptyIds = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.react-flow__node-terminal')].map((n) => n.dataset['id']!))


/** Key press -> the echo arrives from the PTY -> the next frame, measured inside the page. */
async function typingLatency(page: Page, id: string) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`)
  await node.locator('.card-head .name-text, .card-head .name-btn').first().click({ position: { x: 2, y: 2 }, force: true }).catch(() => undefined)
  await node.locator('[data-testid=terminal-body]').click({ force: true })
  await page.evaluate((id) => {
    const w = window as unknown as { __lat: { down: number; out: number[] } }
    w.__lat = { down: 0, out: [] }
    window.addEventListener('keydown', () => (w.__lat.down = performance.now()), true)
    window.api.on('pty:data', (e: { id: string }) => {
      if (e.id !== id || !w.__lat.down) return
      const d = w.__lat.down
      w.__lat.down = 0
      requestAnimationFrame(() => w.__lat.out.push(performance.now() - d))
    })
  }, id)
  for (const ch of 'abcdefghijklmnopqrstuvwxyzabcd') { await page.keyboard.press(ch); await sleep(120) }
  const l = await page.evaluate(() => (window as unknown as { __lat: { out: number[] } }).__lat.out.sort((a, b) => a - b))
  for (let i = 0; i < 30; i++) await page.keyboard.press('Backspace')
  return l.length ? { n: l.length, medianMs: Math.round(l[Math.floor(l.length / 2)]!), p95Ms: Math.round(l[Math.floor(l.length * 0.95)]!), maxMs: Math.round(l[l.length - 1]!) } : { n: 0 }
}

const NO_FX = `.term-card,.term-card.is-selected,.group-frame,.orch-node,.web-tile{box-shadow:none!important} .flow-edge,.react-flow__edge path{filter:none!important} .cmd-bar{backdrop-filter:none!important} .react-flow::after{display:none!important}`
const RUN_EDGES = `.flow-edge{stroke-dasharray:7 5!important;animation:flow-run .6s linear infinite!important}`

async function consoles(n: number) {
  const { app, page } = await launch()
  const key = `consoles${n}`
  try {
    for (let i = 1; i <= n; i++) { await page.getByRole('button', { name: 'New console' }).click(); await expect(page.getByTestId('terminal-node')).toHaveCount(i) }
    await sleep(2500)
    const gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus())
    const canv = await page.evaluate(() => ({ dpr: devicePixelRatio, webgl: document.querySelectorAll('.xterm canvas').length, xterms: document.querySelectorAll('.xterm').length }))
    const r: Record<string, unknown> = { gpu: { gpu_compositing: gpu.gpu_compositing, webgl: gpu.webgl, rasterization: gpu.rasterization }, canv, zoom: await zoomNow(page) }
    r['idle'] = await sample(app, 6000)
    r['idlePan'] = await panFps(page)
    r['idleZoom'] = await zoomFps(page)
    const ids = await ptyIds(page)
    r['typingIdle'] = await typingLatency(page, ids[0]!)
    await writeAll(page, TUI)
    await sleep(1500)
    r['tui'] = await sample(app, 6000)
    r['tuiPan'] = await panFps(page)
    r['tuiZoom'] = await zoomFps(page)
    r['zoomAfter'] = await zoomNow(page)
    r['typingTui'] = await typingLatency(page, ids[0]!)
    if (n === 9) {
      const st = await page.addStyleTag({ content: NO_FX })
      await sleep(500)
      r['tuiPan_noFx'] = await panFps(page)
      r['tuiZoom_noFx'] = await zoomFps(page)
      r['tui_noFx'] = await sample(app, 4000)
      await st.evaluate((el) => (el as HTMLElement).remove())
    }
    await writeAll(page, '\x03')
    await sleep(300)
    await writeAll(page, 'yes\r')
    await sleep(1000)
    r['flood'] = await sample(app, 5000)
    r['floodPan'] = await panFps(page)
    await writeAll(page, '\x03')
    await sleep(1500)
    r['afterFlood'] = await sample(app, 3000)
    // Close all: nothing of the terminals may survive
    const mainPid = app.process().pid!
    const leaders = ptyLeaders(mainPid).map((p) => p.pid)
    { const e = await emptySpot(page); if (e) await page.mouse.click(e.x, e.y) }
    await page.getByRole('button', { name: /^Close all$/ }).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(0, { timeout: 15000 })
    await sleep(2500)
    r['closeAll'] = { leadersBefore: leaders.length, survivors: procs().filter((p) => leaders.includes(p.sid)).map((p) => p.comm) }
    r['afterClose'] = await sample(app, 3000)
    save(key, r)
  } finally {
    await app.close().catch(() => undefined)
  }
}

for (const n of [1, 5, 9]) test(`consoles ${n}`, async () => { test.setTimeout(240_000); await consoles(n) })

test('squad 9 (fake agents, Orchestrator, 4 edges)', async () => {
  test.setTimeout(300_000)
  const repo = setupRepo()
  const { app, page } = await launch(repo.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 120_000 })
    await page.keyboard.press('Escape')
    await sleep(3000)
    const r: Record<string, unknown> = { zoom: await zoomNow(page), edges: await page.locator('[data-testid=flow-edge]').count(), edgeStates: await page.locator('[data-testid=flow-edge]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-state')}|${getComputedStyle(e).animationName}|${getComputedStyle(e).strokeDasharray}`)) }
    await page.screenshot({ path: join(SHOTS, 'squad9-overview.png') })
    r['idle'] = await sample(app, 6000)
    r['idlePan'] = await panFps(page)
    r['idleZoom'] = await zoomFps(page)
    const run = await page.addStyleTag({ content: RUN_EDGES })
    await sleep(500)
    r['edgesRunning_idle'] = await sample(app, 6000)
    r['edgesRunning_pan'] = await panFps(page)
    r['edgesRunning_zoom'] = await zoomFps(page)
    const nofilter = await page.addStyleTag({ content: `.flow-edge,.react-flow__edge path{filter:none!important}` })
    await sleep(500)
    r['edgesRunning_noFilter_idle'] = await sample(app, 6000)
    await nofilter.evaluate((el) => (el as HTMLElement).remove())
    await run.evaluate((el) => (el as HTMLElement).remove())
    const fx = await page.addStyleTag({ content: NO_FX })
    await sleep(500)
    r['noFx_pan'] = await panFps(page)
    r['noFx_zoom'] = await zoomFps(page)
    await fx.evaluate((el) => (el as HTMLElement).remove())
    save('squad9', r)
  } finally {
    await app.close().catch(() => undefined)
  }
})

// Two squads (18 fake agents, 8 edges), idle. Every variant runs on the same board, the CPU ones in alternating rounds (the median
// counts: the machine is shared): the edges as built, then variants set from here (blurred window, the fast rate, a 60 fps glide,
// the old dash animation, no glow filter, offset-path dots). Before the change only the static, dash and offset-path rows exist.
test('edges', async () => {
  test.setTimeout(600_000)
  const repo = setupRepo()
  const { app, page } = await launch(repo.env)
  const squad = async (n: number) => {
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(n, { timeout: 180_000 })
    await page.keyboard.press('Escape')
  }
  const states = () => page.evaluate(() => [...new Set([...document.querySelectorAll('.flow-runner')].flatMap((e) => e.getAnimations().map((a) => `${a.playState}@${a.playbackRate}`)))])
  // as the app does for a speed change: the rate, then back onto the shared step grid (FlowEdge snap)
  const setRate = (k: number, easing?: 'linear' | 'steps') =>
    page.evaluate(
      ([k, easing]) =>
        document.querySelectorAll('.flow-runner').forEach((e) =>
          e.getAnimations().forEach((a) => {
            if (easing) a.effect!.updateTiming({ easing: easing === 'steps' ? `steps(${Number(a.effect!.getTiming().duration) / 64})` : 'linear' })
            a.playbackRate = k
            void a.ready.then(() => a.startTime !== null && (a.startTime = Math.round(Number(a.startTime) / 64) * 64))
          }),
        ),
      [k, easing] as const,
    )
  const blur = (on: boolean) => page.evaluate((on) => window.dispatchEvent(new Event(on ? 'blur' : 'focus')), on)
  const css = async (content: string) => {
    const st = await page.addStyleTag({ content })
    await sleep(800)
    return () => st.evaluate((el) => (el as HTMLElement).remove())
  }
  const cpu = (x: Awaited<ReturnType<typeof sample>>) => ({ renderer: x.by['Tab']?.cpu ?? 0, gpu: x.by['GPU']?.cpu ?? 0, app: x.appCpu })
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const none = async () => undefined
  try {
    await openRepo(page)
    await squad(9)
    await squad(18)
    await sleep(5000)
    const animated = (await page.locator('.flow-runner').evaluateAll((els) => els.flatMap((e) => e.getAnimations()).length)) > 0
    const r: Record<string, unknown> = { zoom: await zoomNow(page), edges: await page.locator('[data-testid=flow-edge]').count(), runners: await page.locator('.flow-runner').count(), animated }
    await page.screenshot({ path: join(SHOTS, 'edges-overview.png') })
    const variants: Record<string, { on: () => Promise<unknown>; off: () => Promise<unknown> }> = animated
      ? {
          static: { on: () => blur(true), off: () => blur(false) }, // blurred: every dot paused, the line as drawn
          slow: { on: none, off: none },
          fast: { on: () => setRate(3), off: () => setRate(1) },
          glide60: { on: () => setRate(1, 'linear'), off: () => setRate(1, 'steps') },
        }
      : { static: { on: none, off: none } }
    const rounds: Record<string, ReturnType<typeof cpu>[]> = {}
    for (let round = 0; round < 3; round++)
      for (const [k, v] of Object.entries(variants)) {
        await v.on()
        await sleep(800)
        if (round === 0) r[`${k}States`] = await states()
        ;(rounds[k] ??= []).push(cpu(await sample(app, 6000)))
        await v.off()
      }
    r['rounds'] = rounds
    r['median'] = Object.fromEntries(Object.entries(rounds).map(([k, xs]) => [k, { renderer: median(xs.map((x) => x.renderer)), gpu: median(xs.map((x) => x.gpu)), app: median(xs.map((x) => x.app)) }]))
    for (const k of Object.keys(variants).filter((k) => k !== 'glide60')) {
      await variants[k]!.on()
      await sleep(800)
      r[`${k}Pan`] = await panFps(page)
      r[`${k}Zoom`] = await zoomFps(page)
      await variants[k]!.off()
    }
    // the old firing animation, forced on every edge (dots hidden so only the dash animation counts)
    const old = await css(`.flow-runners{display:none!important} ${RUN_EDGES} @keyframes flow-run { to { stroke-dashoffset: -12; } }`)
    r['oldDash'] = { cpu: cpu(await sample(app, 6000)), pan: await panFps(page), zoom: await zoomFps(page) }
    await old()
    // the glow filter on a still line (dots paused)
    await blur(true)
    const nofilter = await css('.flow-edge,.react-flow__edge path{filter:none!important}')
    r['staticNoFilter'] = { cpu: cpu(await sample(app, 6000)), pan: await panFps(page) }
    await nofilter()
    await blur(false)
    // the alternative technique: as many dots (3 an edge), moved by CSS offset-path/offset-distance
    const undo = await css(`.flow-runners{display:none!important} .op-dot{position:absolute;left:0;top:0;width:5px;height:5px;margin:-2.5px;border-radius:50%;background:#ff9a72;animation:op 6s linear infinite} @keyframes op{to{offset-distance:100%}}`)
    await page.evaluate(() => {
      const layer = document.querySelector('.react-flow__edgelabel-renderer')!
      for (const p of document.querySelectorAll<SVGPathElement>('[data-testid=flow-edge]'))
        for (let i = 0; i < 3; i++) {
          const d = document.createElement('div')
          d.className = 'op-dot'
          d.style.offsetPath = `path('${p.getAttribute('d')}')`
          d.style.animationDelay = `${-2 * i}s`
          layer.appendChild(d)
        }
    })
    await sleep(800)
    r['offsetPath'] = { cpu: cpu(await sample(app, 6000)) }
    await page.evaluate(() => document.querySelectorAll('.op-dot').forEach((d) => d.remove()))
    await undo()
    save(`edges_${process.env['EDGES_LABEL'] ?? 'run'}`, r)
  } finally {
    await app.close().catch(() => undefined)
  }
})

// the xterm canvas must sit on whole device pixels and be drawn 1:1 once a gesture has settled
function assertSharp(label: string, r: unknown) {
  const m = r as { distX: number; distY: number; scale: number } | null
  expect.soft(m, label).not.toBeNull()
  if (!m) return
  console.log(`${label} distX=${m.distX} distY=${m.distY} scale=${m.scale}`)
  expect.soft(m.distX, `${label} x`).toBeLessThan(0.02)
  expect.soft(m.distY, `${label} y`).toBeLessThan(0.02)
  expect.soft(Math.abs(m.scale - 1), `${label} bitmap scale`).toBeLessThan(0.001)
}

test('zoom sharpness and maximize (1 console)', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'New console' }).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await sleep(2000)
    await writeAll(page, `clear; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "$i The quick brown fox jumps over the lazy dog 0123456789 {}[]() => ilI1 O0 rn m"; done\r`)
    await sleep(800)
    const card = page.getByTestId('terminal-node')
    const info = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.xterm-screen canvas')
        const host = document.querySelector<HTMLElement>('.xterm')
        if (!c || !host) return null
        const b = c.getBoundingClientRect()
        const dpr = devicePixelRatio
        const dist = (v: number) => Math.abs(v - Math.round(v))
        const zoom = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform).a
        return { zoom: +zoom.toFixed(4), dpr, bitmapW: c.width, bitmapH: c.height, shownW: +(b.width * dpr).toFixed(3), shownH: +(b.height * dpr).toFixed(3), scale: +(c.width / (b.width * dpr)).toFixed(4), leftFrac: +((b.left * dpr) % 1).toFixed(3), topFrac: +((b.top * dpr) % 1).toFixed(3), distX: +dist(b.left * dpr).toFixed(3), distY: +dist(b.top * dpr).toFixed(3), fontPx: getComputedStyle(host.querySelector('.xterm-rows') ?? host).fontSize }
      })
    const shot = async (name: string) => {
      const b = (await card.boundingBox())!
      const clip = { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(700, b.width), height: Math.min(260, b.height) }
      await page.screenshot({ path: join(SHOTS, `depois-${name}.png`), clip })
    }
    const out: Record<string, unknown> = {}
    const spot = (await emptySpot(page))!
    const to = async (target: number) => {
      await page.mouse.move(spot.x, spot.y)
      for (let i = 0; i < 400; i++) {
        const z = await zoomNow(page)
        if (Math.abs(z - target) < 0.03) break
        await page.mouse.wheel(0, z > target ? 12 : -12)
        await sleep(15)
      }
      await sleep(600) // past the 150 ms settle
    }
    for (const z of [1, 0.5, 0.75, 1.5, 2]) {
      await to(z)
      // bring the card to the top-left of the free area so the clip is inside the window
      const b = (await card.boundingBox())!
      const s2 = (await emptySpot(page)) ?? spot
      await page.mouse.move(s2.x, s2.y); await page.mouse.down(); await page.mouse.move(s2.x + (100 - b.x), s2.y + (70 - b.y), { steps: 4 }); await page.mouse.up()
      await sleep(500)
      await card.locator('.card-head').click({ position: { x: 4, y: 4 }, force: true }) // a selected card keeps its terminal below ~0.82 (the pane click above deselected it)
      await sleep(300)
      out[`z${z}`] = await info()
      assertSharp(`z${z}`, out[`z${z}`])
      await shot(`zoom-${Math.round(z * 100)}`)
    }
    await to(1)
    await card.getByRole('button', { name: /^Maximize/ }).click()
    await sleep(900)
    out['maximized@1'] = await info()
    assertSharp('maximized@1', out['maximized@1'])
    await page.screenshot({ path: join(SHOTS, 'depois-maximizado-z100.png'), clip: { x: 76, y: 56, width: 760, height: 260 } })
    await page.keyboard.press('Escape').catch(() => undefined)
    save('zoom', out)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('web tile: when the page shows, and recovery from a killed renderer', async () => {
  test.setTimeout(180_000)
  const srv = createServer((_q, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Local</title><body style="background:#16324f;color:#fff;font:28px sans-serif">hello</body>'))
  await new Promise<void>((d) => srv.listen(0, '127.0.0.1', d))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`
  const { app, page } = await launch()
  const out: Record<string, unknown> = {}
  try {
    const tile = page.getByTestId('web-tile')
    const state = async () => ({ shown: await tile.getAttribute('data-shown'), zoom: +(await zoomNow(page)).toFixed(2), body: await page.locator('.tile-body').evaluate((el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }), win: await page.evaluate(() => ({ w: innerWidth, h: innerHeight })), title: await page.getByTestId('tile-title').textContent() })
    await page.getByRole('toolbar', { name: 'Board tools' }).getByRole('button', { name: 'Web tile', exact: true }).click()
    const dlg = page.getByRole('dialog', { name: 'New web tile' })
    await dlg.getByLabel('Address').fill(url)
    await dlg.getByRole('button', { name: 'Open' }).click()
    await expect(tile).toHaveCount(1)
    await sleep(2000)
    out['default@1600x900'] = await state()
    await page.screenshot({ path: join(SHOTS, 'webtile-default.png') })
    const idleWithTile = await sample(app, 5000)
    out['idleWithTile'] = idleWithTile
    // zoom in: the tile grows past the free area
    const spot = (await emptySpot(page))!
    await page.mouse.move(spot.x, spot.y)
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -40); await sleep(15) }
    await sleep(800)
    out['zoomedIn'] = await state()
    for (let i = 0; i < 400 && Math.abs((await zoomNow(page)) - 1) > 0.03; i++) { await page.mouse.wheel(0, (await zoomNow(page)) > 1 ? 12 : -12); await sleep(15) }
    await sleep(800)
    out['backTo1'] = await state()
    // a tile of the asked minimum useful size (1024x640) in the default window (1280x800)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800))
    await sleep(800)
    out['default@1280x800'] = await state()
    out['freeArea@1280x800'] = await page.evaluate(() => ({ w: innerWidth - 76 - 24, h: innerHeight - 56 - 140 }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900))
    await sleep(800)
    // 20 rounds of move + zoom
    let drops = 0
    for (let i = 0; i < 20; i++) {
      const h = (await tile.locator('.card-head').boundingBox())!
      await page.mouse.move(h.x + 60, h.y + 10); await page.mouse.down(); await page.mouse.move(h.x + 60 + (i % 2 ? -40 : 40), h.y + 10 + (i % 2 ? -20 : 20), { steps: 3 }); await page.mouse.up()
      const s3 = (await emptySpot(page)) ?? spot
      await page.mouse.move(s3.x, s3.y); await page.mouse.wheel(0, i % 2 ? -30 : 30)
      await sleep(250)
      const alive = await app.evaluate(({ webContents, session }) => webContents.getAllWebContents().filter((w) => w.session === session.fromPartition('webtiles') && !w.isDestroyed() && !w.isCrashed()).length)
      if (alive !== 1) drops++
    }
    out['moveZoom20'] = { drops, end: await state() }
    // kill the page's renderer by force
    await app.evaluate(({ webContents, session }) => webContents.getAllWebContents().filter((w) => w.session === session.fromPartition('webtiles'))[0]?.forcefullyCrashRenderer())
    await sleep(1500)
    out['afterKill'] = await state()
    await page.screenshot({ path: join(SHOTS, 'webtile-after-kill.png') })
    await tile.getByRole('button', { name: 'Reload page' }).click()
    await sleep(2500)
    out['afterReload'] = await state()
    out['appAlive'] = await page.getByRole('button', { name: 'New console' }).isVisible()
    save('webtile', out)
  } finally {
    await app.close().catch(() => undefined)
    srv.close()
  }
})

test('maximized at a fractional zoom', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'New console' }).click()
    await sleep(1500)
    await writeAll(page, `clear; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "$i The quick brown fox jumps over the lazy dog 0123456789 {}[]() => ilI1 O0 rn m"; done\r`)
    const spot = (await emptySpot(page))!
    const out: Record<string, unknown> = {}
    for (const target of [0.62, 1.37]) {
      await page.mouse.move(spot.x, spot.y)
      for (let i = 0; i < 400; i++) { const z = await zoomNow(page); if (Math.abs(z - target) < 0.02) break; await page.mouse.wheel(0, z > target ? 10 : -10); await sleep(15) }
      await sleep(600)
      await page.getByTestId('terminal-node').getByRole('button', { name: /^Maximize/ }).click({ force: true })
      await sleep(900)
      out[`max@${target}`] = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.xterm-screen canvas')!
        const b = c.getBoundingClientRect()
        const card = document.querySelector('[data-testid=terminal-node]')!.getBoundingClientRect()
        return { zoom: +new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform).a.toFixed(4), bitmapW: c.width, shownW: +b.width.toFixed(3), scale: +(c.width / b.width).toFixed(4), leftFrac: +(b.left % 1).toFixed(3), topFrac: +(b.top % 1).toFixed(3), distX: +Math.abs(b.left - Math.round(b.left)).toFixed(3), distY: +Math.abs(b.top - Math.round(b.top)).toFixed(3), card: { x: +card.x.toFixed(2), y: +card.y.toFixed(2), w: +card.width.toFixed(2), h: +card.height.toFixed(2) } }
      })
      assertSharp(`max@${target}`, out[`max@${target}`])
      await page.screenshot({ path: join(SHOTS, `depois-maximizado-z${Math.round(target * 100)}.png`), clip: { x: 76, y: 56, width: 760, height: 200 } })
      await page.getByTestId('terminal-node').getByRole('button', { name: /^Restore/ }).click({ force: true })
      await sleep(500)
    }
    save('maxFrac', out)
  } finally { await app.close().catch(() => undefined) }
})

test('terminal sharpness for a card inside a group (Small squad)', async () => {
  test.setTimeout(300_000)
  const repo = setupRepo()
  const { app, page } = await launch(repo.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Small squad/ }).click()
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(5, { timeout: 120_000 })
    await page.keyboard.press('Escape')
    await sleep(1500)
    const spot = (await emptySpot(page))!
    const out: Record<string, unknown> = {}
    // grouped cards cannot be selected, so below ~0.82 they show the summary (no canvas): measure where terminals show
    for (const target of [0.9, 1.37]) {
      await page.mouse.move(spot.x, spot.y)
      for (let i = 0; i < 400; i++) { const z = await zoomNow(page); if (Math.abs(z - target) < 0.03) break; await page.mouse.wheel(0, z > target ? 10 : -10); await sleep(15) }
      // select a grouped card (click its header) so its terminal shows
      await page.locator('[data-testid=agent-node] .card-head').first().click({ position: { x: 4, y: 4 }, force: true })
      await sleep(900)
      out[`group@${target}`] = await page.evaluate(() => {
        // every grouped card whose terminal shows: the worst one counts
        const cs = [...document.querySelectorAll<HTMLCanvasElement>('.term-card:not([data-lowzoom]) .xterm-screen canvas')].filter((c) => c.getBoundingClientRect().width > 0)
        if (cs.length === 0) return null
        const dpr = devicePixelRatio
        const dist = (v: number) => Math.abs(v - Math.round(v))
        const bs = cs.map((c) => ({ b: c.getBoundingClientRect(), c }))
        return {
          zoom: +new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform).a.toFixed(4),
          cards: cs.length,
          distX: +Math.max(...bs.map(({ b }) => dist(b.left * dpr))).toFixed(3),
          distY: +Math.max(...bs.map(({ b }) => dist(b.top * dpr))).toFixed(3),
          scale: +bs.reduce((w, { b, c }) => (Math.abs(c.width / (b.width * dpr) - 1) > Math.abs(w - 1) ? c.width / (b.width * dpr) : w), 1).toFixed(4),
        }
      })
      assertSharp(`group@${target}`, out[`group@${target}`])
      await page.screenshot({ path: join(SHOTS, `depois-grupo-z${Math.round(target * 100)}.png`) })
    }
    save('groupSharp', out)
  } finally {
    await app.close().catch(() => undefined)
  }
})

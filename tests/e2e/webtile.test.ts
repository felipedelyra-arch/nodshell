import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { alive, cleanupTemp, launch, newConsole, readFile, tempDir, typeIn } from './helpers'
import { openRepo, setupRepo } from './repo'

test.afterEach(cleanupTemp)

/** A local site made by the test: a page with a title, a link to a local file, a redirect to one, a popup and a download. */
async function site() {
  let content = { title: 'Preview One', body: 'first version' }
  let hits = 0
  const srv = createServer((req, res) => {
    hits++
    if (req.url === '/redirect') return void res.writeHead(302, { Location: 'file:///etc/passwd' }).end()
    if (req.url === '/download') return void res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="x.bin"' }).end('data')
    if (req.url === '/other') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Other page</title><p>other</p>')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(
      `<!doctype html><title>${content.title}</title><body style="margin:0;background:#16324f;color:#fff;font:28px sans-serif;padding:24px">` +
        `<h1 id="h">${content.body}</h1><a id="file" href="file:///etc/passwd">local file</a> <a id="redir" href="/redirect">redirect</a> ` +
        `<button id="pop" onclick="window.open('/other')">popup</button><button id="geo" onclick="navigator.geolocation.getCurrentPosition(()=>{},()=>{})">where</button></body>`,
    )
  })
  await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`
  return {
    url,
    hits: () => hits,
    set: (title: string, body: string) => void (content = { title, body }),
    close: () => new Promise<void>((done) => (srv.closeAllConnections(), srv.close(() => done()))),
  }
}

const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Board tools' }).getByRole('button', { name, exact: true })
const tile = (page: Page) => page.getByTestId('web-tile')
const title = (page: Page) => page.getByTestId('tile-title')

/** The tiles' pages as main has them (their own session), oldest first. */
const pages = (app: ElectronApplication) =>
  app.evaluate(({ webContents, session }) => {
    const s = session.fromPartition('webtiles')
    return webContents.getAllWebContents().filter((w) => w.session === s && !w.isDestroyed()).sort((a, b) => a.id - b.id).map((w) => ({ id: w.id, url: w.getURL(), focused: w.isFocused() }))
  })
/** Runs `code` in a tile's page (as a user gesture), the way an attacker's page would. */
const inTile = (app: ElectronApplication, code: string, index = 0) =>
  app.evaluate(async ({ webContents, session }, [code, index]) => {
    const s = session.fromPartition('webtiles')
    const w = webContents.getAllWebContents().filter((x) => x.session === s && !x.isDestroyed()).sort((a, b) => a.id - b.id)[index as number]
    return w ? ((await w.executeJavaScript(code as string, true)) as unknown) : 'no tile'
  }, [code, index] as const)
/** Whether each tile's native view (its clipping frame) is shown over the window. */
const shown = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getVisible()))
type Bounds = { x: number; y: number; width: number; height: number }
/** Each tile's frame in the window (the visible part) and its page inside the frame (the whole body). */
const frames = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((c) => ({ visible: c.getVisible(), clip: c.getBounds(), page: c.children[0]?.getBounds() ?? null })))

async function openTile(page: Page, address: string): Promise<void> {
  await tool(page, 'Web tile').click()
  const dlg = page.getByRole('dialog', { name: 'New web tile' })
  await expect(dlg.getByLabel('Address')).toHaveValue('http://localhost:3000')
  await dlg.getByLabel('Address').fill(address)
  await dlg.getByRole('button', { name: 'Open' }).click()
  await expect(dlg).toHaveCount(0)
}

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

test('acceptance: a tile shows the local page live with its title; a change and a reload update it (with a squad on the board)', async () => {
  test.setTimeout(180_000)
  const s = await site()
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await expect.poll(async () => (await pages(app)).map((p) => p.url)).toEqual([s.url])
    expect(await inTile(app, "document.getElementById('h').textContent")).toBe('first version')
    await expect.poll(() => shown(app)).toEqual([true])
    await expect(tile(page)).toHaveAttribute('data-shown', 'true')

    s.set('Preview Two', 'second version')
    await tile(page).getByRole('button', { name: 'Reload page' }).click()
    await expect(title(page)).toHaveText('Preview Two')
    await expect.poll(() => inTile(app, "document.getElementById('h').textContent")).toBe('second version')
    await expect(tile(page).getByTestId('tile-mirror')).toHaveCount(0) // the live page is shown, not the static mirror
    await page.screenshot({ path: test.info().outputPath('f12.png') })
    // the native page is not part of the page screenshot (the body there is empty): the whole screen as the X server shows it
    const png = await app.evaluate(async ({ desktopCapturer }) => {
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1680, height: 1050 } })
      return src ? src.thumbnail.toPNG().toString('base64') : ''
    })
    if (png) writeFileSync(test.info().outputPath('f12-screen.png'), Buffer.from(png, 'base64'))
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('only http and https: typed file:, app:, javascript: and data: are refused; links and redirects to file: are blocked; window.open opens nothing; downloads are cancelled', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page, errors, tmp } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    const head = tile(page)
    for (const bad of ['file:///etc/passwd', 'app://app/index.html', 'javascript:alert(1)', 'data:text/html,<b>x</b>']) {
      const field = head.getByRole('textbox', { name: 'Address' })
      await field.fill(bad)
      await field.press('Enter')
      await expect(page.getByRole('alert')).toContainText('Only http and https addresses are allowed')
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await field.press('Escape')
      await expect(field).toHaveValue(s.url) // restored, no longer marked
      await expect(field).not.toHaveAttribute('aria-invalid', 'true')
      expect((await pages(app)).map((p) => p.url)).toEqual([s.url])
    }
    // the same refusal straight through the channel
    await expect(page.evaluate(() => window.api.invoke('webtile:create', { address: 'file:///etc/passwd', workspaceId: crypto.randomUUID() }))).rejects.toThrow(/http and https/)

    const before = await app.evaluate(({ webContents, BrowserWindow }) => ({ contents: webContents.getAllWebContents().length, windows: BrowserWindow.getAllWindows().length }))
    // each tried from inside the page (a refusal may also throw in the page: that is fine)
    for (const go of ["document.getElementById('file').click()", "document.getElementById('redir').click()", "location.href = 'app://app/index.html'", "location.href = 'data:text/html,hi'", "location.href = 'view-source:' + location.href", "document.getElementById('pop').click()", "location.href = '/download'"]) {
      await inTile(app, `try { ${go} } catch {} 'tried'`)
    }
    expect(await inTile(app, "String(window.open('/other'))")).toBe('null')
    await page.waitForTimeout(1500)
    expect((await pages(app)).map((p) => p.url)).toEqual([s.url])
    expect(await inTile(app, "document.getElementById('h').textContent")).toBe('first version')
    expect(await app.evaluate(({ webContents, BrowserWindow }) => ({ contents: webContents.getAllWebContents().length, windows: BrowserWindow.getAllWindows().length }))).toEqual(before)
    expect(existsSync(join(tmp, 'Downloads')) ? readdirSync(join(tmp, 'Downloads')) : []).toEqual([])
    await expect(title(page)).toHaveText('Preview One')
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('the page cannot reach the app: no API, no Node, no app protocol, its own in-memory session, every permission denied', async () => {
  test.setTimeout(60_000)
  const s = await site()
  const { app, page, errors } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    expect(await inTile(app, 'typeof window.api')).toBe('undefined')
    expect(await inTile(app, 'typeof require')).toBe('undefined')
    expect(await inTile(app, 'typeof process')).toBe('undefined')
    expect(await inTile(app, "fetch('app://app/index.html').then(() => 'loaded', () => 'failed')")).toBe('failed')
    expect(await inTile(app, "fetch('app://app/board-image/00000000-0000-4000-8000-000000000000').then(() => 'loaded', () => 'failed')")).toBe('failed')
    expect(await inTile(app, "navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => 'denied ' + e.name)")).toMatch(/^denied/)
    expect(await inTile(app, "new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('denied ' + e.code)))")).toBe('denied 1')
    expect(await inTile(app, "navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)")).toBe('denied')
    expect(await inTile(app, 'Notification.requestPermission()')).toBe('denied')
    expect(await inTile(app, "navigator.clipboard.readText().then(() => 'read', () => 'denied')")).toBe('denied')
    // alert, confirm and prompt never block (dialogs are disabled for tiles)
    expect(await inTile(app, "alert('x'); let p; try { p = String(prompt('z')) } catch { p = 'unsupported' } 'confirm ' + String(confirm('y')) + ', prompt ' + p")).toMatch(/^confirm false, prompt (null|unsupported)$/)
    // what the page stores stays in its own session, never the app's
    await inTile(app, "document.cookie = 'tile=1; path=/'; localStorage.setItem('k', 'v'); 'ok'")
    const where = await app.evaluate(async ({ webContents, session }) => {
      const s = session.fromPartition('webtiles')
      const w = webContents.getAllWebContents().find((x) => x.session === s)!
      const prefs = (w as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
      return {
        own: w.session !== session.defaultSession,
        persistent: s.isPersistent(),
        appCookies: (await session.defaultSession.cookies.get({})).map((c) => c.name),
        tileCookies: (await s.cookies.get({})).map((c) => c.name),
        prefs: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity, preload: prefs.preload ?? null },
      }
    })
    expect(where).toEqual({ own: true, persistent: false, appCookies: [], tileCookies: ['tile'], prefs: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: null } })
    // the app window still has its API and its microphone rule; nothing above reached it
    expect(await page.evaluate(() => typeof window.api.invoke)).toBe('function')
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('the native page hides under a dialog and a maximized card, is cut at the bottom bar, and comes back; closing a tile never touches a console', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page, errors, tmp } = await launch()
  try {
    await newConsole(page, 1)
    const pidFile = join(tmp, 'pid')
    await typeIn(page, 0, `echo $$ > '${pidFile}'`)
    const pid = Number(await readFile(pidFile))
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await expect.poll(() => shown(app)).toEqual([true])

    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Memory' })).toBeVisible()
    await expect.poll(() => shown(app)).toEqual([false])
    await expect(tile(page).getByTestId('tile-mirror')).toContainText('Preview One') // the static mirror instead: title and address
    await expect(tile(page).getByTestId('tile-mirror')).toContainText(s.url)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Memory' })).toHaveCount(0)
    await expect.poll(() => shown(app)).toEqual([true])

    await page.getByRole('button', { name: /^Maximize / }).click()
    await expect.poll(() => shown(app)).toEqual([false])
    await page.getByRole('button', { name: /^Restore / }).click()
    await expect.poll(() => shown(app)).toEqual([true])

    // a drawing tool covers the board
    await tool(page, 'Pen').click()
    await expect.poll(() => shown(app)).toEqual([false])
    await tool(page, 'Select').click()
    await expect.poll(() => shown(app)).toEqual([true])

    // dragged down under the bottom bar: hidden; back up: shown
    const bar = (await tile(page).locator('.card-head').boundingBox())!
    const from = { x: bar.x + 40, y: bar.y + bar.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y + 60, { steps: 4 })
    await expect.poll(() => shown(app)).toEqual([false]) // hidden while it moves
    await page.mouse.move(from.x, 650, { steps: 8 }) // the title bar stays above the bars; the page reaches under them
    await page.mouse.up()
    // shown again, cut where the bars begin
    await expect.poll(() => shown(app)).toEqual([true])
    const [low0] = await frames(app)
    expect(low0!.clip.height).toBeLessThan(low0!.page!.height)
    const low = (await tile(page).locator('.card-head').boundingBox())!
    await page.mouse.move(from.x, low.y + low.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => shown(app)).toEqual([true])

    await tile(page).getByRole('button', { name: 'Close web tile' }).click()
    await expect(tile(page)).toHaveCount(0)
    await expect.poll(async () => (await pages(app)).length).toBe(0)
    expect(await shown(app)).toEqual([])
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    expect(alive(pid)).toBe(true)
    const okFile = join(tmp, 'ok')
    await typeIn(page, 0, `echo still-here > '${okFile}'`)
    expect(await readFile(okFile)).toBe('still-here')
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('a tile partly outside the free area shows the part inside it, at the right place and without the page changing size; wholly outside it hides; closing leaves no view', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page, errors } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800)) // the default window
    await expect.poll(() => page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe('1280x800')
    const before = (await frames(app)).length
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await settled(page)
    const body = () => page.locator('[data-tile-body]').evaluate((el) => el.getBoundingClientRect().toJSON() as Bounds)
    // the board's free area as the tile measures it (the window minus the chrome)
    const free = () =>
      page.evaluate((): Bounds => {
        const bottom = Math.max(140, innerHeight - (document.querySelector('[data-chrome=bottom]')?.getBoundingClientRect().top ?? innerHeight) + 8)
        return { x: 76, y: 56, width: innerWidth - 100, height: innerHeight - 56 - bottom }
      })
    const cut = (a: Bounds, b: Bounds): Bounds => {
      const x = Math.max(a.x, b.x)
      const y = Math.max(a.y, b.y)
      return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
    }
    const near = (a: Bounds, b: Bounds) => [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].every((d) => Math.abs(d) <= 2)
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.mouse.up()
    }
    /** the frame is the visible part of the body, and the page inside it is the whole body */
    const placedRight = async () => {
      const [f] = await frames(app)
      const b = await body()
      const c = cut(b, await free())
      return !!f && f.visible && near(f.clip, c) && near({ ...f.page!, x: f.clip.x + f.page!.x, y: f.clip.y + f.page!.y }, b)
    }

    // (1) the title bar to the top left, then the body resized to 1024x640: it cannot fit the 1180x604 free area, yet shows
    const head = (await tile(page).locator('.card-head').boundingBox())!
    let b = await body()
    await drag({ x: head.x + 60, y: head.y + 10 }, { x: head.x + 60 + 100 - b.x, y: head.y + 10 + 110 - b.y })
    await tile(page).locator('.card-head').click({ position: { x: 60, y: 10 } }) // selected: its resize handles show
    b = await body()
    const handle = (await page.locator('.react-flow__resize-control.handle.bottom.right').first().boundingBox())!
    const grip = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
    await drag(grip, { x: grip.x + 1024 - b.width, y: grip.y + 640 - b.height })
    b = await body()
    expect(Math.abs(b.width - 1024)).toBeLessThanOrEqual(2)
    expect(Math.abs(b.height - 640)).toBeLessThanOrEqual(2)
    await expect.poll(placedRight).toBe(true)
    await expect(tile(page)).toHaveAttribute('data-shown', 'true')
    expect((await frames(app))[0]!.clip.height).toBeLessThan(640) // cut at the bottom bars

    // (2) zoomed in past the free area (wheel over the board right of the tile): still shown, cut on every side it passes
    const zoom = () => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
    const spot = { x: 1200, y: 300 }
    await page.mouse.move(spot.x, spot.y)
    await expect.poll(async () => (await page.mouse.wheel(0, -100), (await zoom()) > 1.25), { timeout: 20_000 }).toBe(true)
    await expect.poll(placedRight).toBe(true)
    b = await body()
    const f = await free()
    expect(b.width).toBeGreaterThan(f.width)
    expect(b.height).toBeGreaterThan(f.height)
    const width = await inTile(app, 'innerWidth')
    // a pan moves the cut; the page keeps its size (no reflow)
    const clip0 = (await frames(app))[0]!.clip
    await drag({ x: 1220, y: 300 }, { x: 1180, y: 250 })
    await expect.poll(placedRight).toBe(true)
    expect((await frames(app))[0]!.clip).not.toEqual(clip0)
    expect(await inTile(app, 'innerWidth')).toBe(width)

    // (3) panned wholly under the bottom bars: hidden (the static mirror); back: shown
    await drag({ x: 1220, y: 80 }, { x: 1220, y: 790 })
    await expect.poll(() => shown(app)).toEqual([false])
    expect((await body()).y).toBeGreaterThan(f.y + f.height - 16)
    await expect(tile(page)).toHaveAttribute('data-shown', 'false')
    await drag({ x: 1220, y: 640 }, { x: 1220, y: 80 })
    await expect.poll(placedRight).toBe(true)
    expect(await inTile(app, 'innerWidth')).toBe(width)

    // (5) closing leaves no frame or page behind
    await tile(page).getByRole('button', { name: 'Close web tile' }).click()
    await expect.poll(async () => (await pages(app)).length).toBe(0)
    expect((await frames(app)).length).toBe(before)
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('at most 4 web tiles per window: the toolbar button is disabled with a tip and main refuses a fifth', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page, errors } = await launch()
  try {
    for (let i = 1; i <= 4; i++) {
      await openTile(page, s.url)
      await expect(tile(page)).toHaveCount(i)
    }
    await expect.poll(async () => (await pages(app)).length).toBe(4)
    const btn = tool(page, 'Web tile')
    await expect(btn).toHaveAttribute('aria-disabled', 'true')
    await expect(btn).toHaveAttribute('data-tip', 'Web tile limit reached (4)')
    await btn.click({ force: true })
    await expect(page.getByRole('dialog', { name: 'New web tile' })).toHaveCount(0)
    await expect(page.evaluate((url) => window.api.invoke('webtile:create', { address: url, workspaceId: crypto.randomUUID() }), s.url)).rejects.toThrow(/limit reached/)
    await tile(page).first().getByRole('button', { name: 'Close web tile' }).click()
    await expect(btn).not.toHaveAttribute('aria-disabled', 'true')
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('quit and reopen brings the tile back at its address and place', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const r = setupRepo()
  const home = tempDir('nodshell-e2e-home-')
  const env = { ...r.env, HOME: home, NODSHELL_USER_DATA: join(home, 'userdata'), NODSHELL_TEST_RESTORE: 'resume' }
  let { app, page, errors } = await launch(env)
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    // somewhere else on the page: about:blank is allowed, the next address is what is saved
    await tile(page).getByRole('textbox', { name: 'Address' }).fill(`${s.url}other`)
    await tile(page).getByRole('textbox', { name: 'Address' }).press('Enter')
    await expect(title(page)).toHaveText('Other page')
    const place = await tile(page).evaluate((el) => (el.closest('.react-flow__node') as HTMLElement).style.transform)
    await page.waitForTimeout(1200) // the layout is saved 500 ms after the last change
    await clean(page, errors)
    await app.close()

    ;({ app, page, errors } = await launch(env))
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(tile(page)).toHaveCount(1)
    await expect(title(page)).toHaveText('Other page')
    await expect.poll(async () => (await pages(app)).map((p) => p.url)).toEqual([`${s.url}other`])
    expect(await tile(page).evaluate((el) => (el.closest('.react-flow__node') as HTMLElement).style.transform)).toBe(place)
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('keyboard: create a tile, edit its address (Esc cancels, Enter goes), move into the page and come back with F6', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page, errors } = await launch()
  try {
    await tool(page, 'Select').focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
    await expect(tool(page, 'Web tile')).toBeFocused()
    await page.keyboard.press('Enter')
    const field = page.getByRole('dialog', { name: 'New web tile' }).getByLabel('Address')
    await expect(field).toBeFocused()
    await page.keyboard.press('Control+A')
    await page.keyboard.type(s.url)
    await page.keyboard.press('Enter')
    await expect(title(page)).toHaveText('Preview One')
    await expect(tool(page, 'Web tile')).toBeFocused()
    // loading the page did not take the keyboard away from the app (Electron focuses a page as it loads)
    await page.waitForTimeout(500)
    expect((await pages(app))[0]?.focused).toBe(false)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused())).toBe(true)

    const address = tile(page).getByRole('textbox', { name: 'Address' })
    await address.focus()
    await expect(address).toHaveValue(s.url)
    await page.keyboard.type('nowhere')
    await page.keyboard.press('Escape')
    await expect(address).toHaveValue(s.url)
    await expect(address).not.toBeFocused()
    expect((await pages(app)).map((p) => p.url)).toEqual([s.url])
    await address.focus()
    await page.keyboard.press('Control+A')
    await page.keyboard.type(`${s.url}other`)
    await page.keyboard.press('Enter')
    await expect(title(page)).toHaveText('Other page')

    // into the page and back
    await expect.poll(() => shown(app)).toEqual([true])
    const body = page.locator('[data-tile-body]')
    await body.focus()
    await expect(body).toHaveAttribute('aria-label', /F6/)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await pages(app))[0]?.focused).toBe(true)
    await app.evaluate(({ webContents, session }) => {
      const s = session.fromPartition('webtiles')
      webContents.getAllWebContents().find((w) => w.session === s)!.sendInputEvent({ type: 'keyDown', keyCode: 'F6' })
    })
    await expect.poll(async () => (await pages(app))[0]?.focused).toBe(false)
    await expect(body).toBeFocused()
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('a zoomed app page places the view in window pixels; a reload of the app drops every tile view; the build has no default menu', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page } = await launch()
  try {
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)).toBe(true) // no Ctrl+Plus, Ctrl+R or Ctrl+Shift+I from a menu
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await expect.poll(() => shown(app)).toEqual([true])
    // the whole page in window pixels (its frame may cut it)
    const viewBox = async () => {
      const { clip, page: p } = (await frames(app))[0]!
      return { ...p!, x: clip.x + p!.x, y: clip.y + p!.y }
    }
    const body = () => page.locator('[data-tile-body]').evaluate((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number })
    const close = (a: number, b: number) => Math.abs(a - b) <= 1.5
    let css = await body()
    let v = await viewBox()
    await expect.poll(async () => {
      css = await body()
      v = await viewBox()
      return [close(v.x, css.x), close(v.y, css.y), close(v.width, css.width), close(v.height, css.height)]
    }).toEqual([true, true, true, true])
    // the app page zoomed (as Ctrl+Plus would): the view follows in window pixels, never shifted over the chrome
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.1))
    await expect.poll(async () => {
      css = await body()
      v = await viewBox()
      return [...(await shown(app)), close(v.x, css.x * 1.1), close(v.y, css.y * 1.1), close(v.width, css.width * 1.1), close(v.height, css.height * 1.1)]
    }).toEqual([true, true, true, true, true])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1))

    // the app page reloads: its tile nodes are gone, so no view is left alive, shown or counting toward the limit
    await page.reload()
    await page.waitForSelector('button:has-text("New console")')
    await expect.poll(async () => (await pages(app)).length).toBe(0)
    expect(await shown(app)).toEqual([])
    await expect(tile(page)).toHaveCount(0)
    for (let i = 1; i <= 4; i++) await openTile(page, s.url)
    await expect(tile(page)).toHaveCount(4)
    await expect.poll(async () => (await pages(app)).length).toBe(4)
  } finally {
    await app.close()
    await s.close()
  }
})

test('without the default menu, copy and paste still work in a field and in a terminal', async () => {
  test.setTimeout(60_000)
  const { app, page, tmp, errors } = await launch()
  try {
    const out = join(tmp, 'pasted')
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `echo pasted > '${out}'`)
    // a field: paste, then copy what is selected back
    await tool(page, 'Web tile').click()
    const field = page.getByRole('dialog', { name: 'New web tile' }).getByLabel('Address')
    await field.press('Control+A')
    await field.press('Control+V')
    await expect(field).toHaveValue(`echo pasted > '${out}'`)
    await field.fill('http://localhost:4321/copied')
    await field.press('Control+A')
    await field.press('Control+C')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('http://localhost:4321/copied')
    await field.press('Escape')
    // a terminal: Ctrl+Shift+V pastes (as a bracketed paste), Enter runs it
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `echo pasted > '${out}'`)
    await newConsole(page, 1)
    await page.getByTestId('terminal-body').click()
    await page.keyboard.press('Control+Shift+V')
    await page.keyboard.press('Enter')
    expect(await readFile(out)).toBe('pasted')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('a crashed page says why, is recorded in the diagnostic without its address, and Reload brings it back; the app and a console stay up', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page, tmp } = await launch()
  try {
    await newConsole(page, 1)
    const pidFile = join(tmp, 'pid')
    await typeIn(page, 0, `echo $$ > '${pidFile}'`)
    const pid = Number(await readFile(pidFile))
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await app.evaluate(({ webContents, session }) => {
      const s = session.fromPartition('webtiles')
      webContents.getAllWebContents().find((w) => w.session === s && !w.isDestroyed())!.forcefullyCrashRenderer()
    })
    await expect(title(page)).toContainText(/The page (crashed|was stopped by the system)\. Reload it/)
    expect(alive(pid)).toBe(true)
    await tile(page).getByRole('button', { name: 'Reload page' }).click()
    await expect(title(page)).toHaveText('Preview One')
    await page.getByRole('button', { name: 'Found a bug?' }).click()
    const text = (await page.getByRole('dialog', { name: 'Found a bug?' }).getByLabel('Diagnostic').textContent()) ?? ''
    expect(text).toMatch(/Recent failures:\n[^\n]* gone (crashed|killed) exit=/)
    expect(text).not.toContain('http')
  } finally {
    await app.close()
    await s.close()
  }
})

test('navigation bar: back, forward and reload follow the page history; the address field is always there, follows the page and refuses other schemes', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const { app, page, errors } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    const t = tile(page)
    const back = t.getByRole('button', { name: 'Back', exact: true })
    const fwd = t.getByRole('button', { name: 'Forward', exact: true })
    const field = t.getByRole('textbox', { name: 'Address' })
    await expect(back).toHaveAttribute('aria-disabled', 'true')
    await expect(fwd).toHaveAttribute('aria-disabled', 'true')
    await expect(field).toHaveValue(s.url)

    await field.fill(`${s.url}other`)
    await field.press('Enter')
    await expect(title(page)).toHaveText('Other page')
    await expect(field).toHaveValue(`${s.url}other`)
    await expect(back).toHaveAttribute('aria-disabled', 'false')
    await expect(fwd).toHaveAttribute('aria-disabled', 'true')

    await back.click()
    await expect(title(page)).toHaveText('Preview One')
    await expect(fwd).toHaveAttribute('aria-disabled', 'false')
    await expect(back).toHaveAttribute('aria-disabled', 'true')
    await fwd.click()
    await expect(title(page)).toHaveText('Other page')
    await t.getByRole('button', { name: 'Reload page' }).click()
    await expect(title(page)).toHaveText('Other page')
    expect((await pages(app)).map((p) => p.url)).toEqual([`${s.url}other`])

    // a refused address leaves the page alone and the field marked
    await field.fill('file:///etc/passwd')
    await field.press('Enter')
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    expect((await pages(app)).map((p) => p.url)).toEqual([`${s.url}other`])
    await field.press('Escape')
    await expect(field).toHaveValue(`${s.url}other`)

    // a navigation made inside the page (a link click) shows up in the field while it is not focused
    await back.click()
    await expect(title(page)).toHaveText('Preview One')
    await inTile(app, "history.pushState({}, '', '/pushed'); 'ok'")
    await expect(field).toHaveValue(`${s.url}pushed`)
    await expect(back).toHaveAttribute('aria-disabled', 'false')
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('navigation bar by keyboard: title bar, back, forward, reload, address, then the page body', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    const t = tile(page)
    await t.getByRole('button', { name: 'Close web tile' }).focus()
    // the Back and Forward buttons stay in the tab order even when disabled (aria-disabled, not disabled)
    for (const name of ['Back', 'Forward', 'Reload page']) {
      await page.keyboard.press('Tab')
      await expect(t.getByRole('button', { name, exact: true })).toBeFocused()
    }
    await page.keyboard.press('Tab')
    await expect(t.getByRole('textbox', { name: 'Address' })).toBeFocused()
    await page.keyboard.type('x')
    await page.keyboard.press('Control+A')
    await page.keyboard.type(`${s.url}other`)
    await page.keyboard.press('Enter')
    await expect(title(page)).toHaveText('Other page')
    await page.keyboard.press('Tab')
    await expect(t.getByRole('button', { name: /^Viewport/ })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('[data-tile-body]')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(t.getByRole('button', { name: 'Back', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(title(page)).toHaveText('Preview One')
  } finally {
    await app.close()
    await s.close()
  }
})

test('a localhost address a terminal prints is only offered: nothing loads until the click, once per address, never for other hosts', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const r = setupRepo()
  const { app, page } = await launch(r.env)
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await typeIn(page, 0, `echo ready at ${s.url}`)
    const offer = page.getByRole('status').filter({ hasText: 'printed' })
    await expect(offer).toContainText(s.url.replace(/\/$/, ''))
    await expect(offer.getByRole('button', { name: 'Open as web tile' })).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(tile(page)).toHaveCount(0)
    expect(await pages(app)).toEqual([])
    expect(s.hits()).toBe(0)
    await offer.getByRole('button', { name: 'Open as web tile' }).click()
    await expect(title(page)).toHaveText('Preview One')
    await tile(page).getByRole('button', { name: 'Close web tile' }).click()
    await expect(tile(page)).toHaveCount(0)
    await typeIn(page, 0, `echo again ${s.url}`)
    await typeIn(page, 0, 'echo http://example.com:80/')
    await page.waitForTimeout(1500)
    await expect(page.getByRole('status').filter({ hasText: 'printed' })).toHaveCount(0)
  } finally {
    await app.close()
    await s.close()
  }
})

// ---- default size, viewport presets and focus mode (T4.3) ----
/** The whole screen as the X server shows it (the native page is not part of page.screenshot). */
async function snap(app: ElectronApplication, name: string): Promise<void> {
  const png = await app.evaluate(async ({ desktopCapturer }) => {
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1680, height: 1050 } })
    return src ? src.thumbnail.toPNG().toString('base64') : ''
  })
  if (png) writeFileSync(test.info().outputPath(name), Buffer.from(png, 'base64'))
}
const innerW = (app: ElectronApplication) => inTile(app, 'innerWidth') as Promise<number>
const nodeBox = (page: Page) =>
  tile(page).evaluate((el) => {
    const n = el.closest('.react-flow__node') as HTMLElement
    return { at: n.style.transform, w: n.style.width, h: n.style.height }
  })
const bodyBox = (page: Page) => page.locator('[data-tile-body]').evaluate((el) => el.getBoundingClientRect().toJSON() as Bounds)
const viewport = async (page: Page, name: string) => {
  await tile(page).getByRole('button', { name: /^Viewport/ }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
}
const zoomOf = (page: Page) => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)

/** The board's fit-to-content animation after a new tile has finished (the transform stops changing). */
const settled = (page: Page) =>
  expect
    .poll(async () => {
      const a = await page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform)
      await page.waitForTimeout(400)
      return a === (await page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform))
    })
    .toBe(true)

test('a new tile is 1024x640 and fully shown at 1440x900; each viewport preset lays the page out at its width and Fit goes back', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const { app, page, errors } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await settled(page)
    await expect.poll(() => shown(app)).toEqual([true])
    const z = await zoomOf(page)
    expect(z).toBeLessThanOrEqual(1)
    // 1024x640 at zoom 1 (what the page lays out at), whatever the zoom the view was fitted to
    expect(Math.abs((await innerW(app)) - 1024)).toBeLessThanOrEqual(1)
    expect(Math.abs(((await inTile(app, 'innerHeight')) as number) - 640)).toBeLessThanOrEqual(1)
    const b = await bodyBox(page)
    expect(Math.abs(b.width - 1024 * z)).toBeLessThanOrEqual(2)
    const [f] = await frames(app)
    expect(f!.clip.width).toBe(f!.page!.width) // nothing cut
    await snap(app, 'tile-default.png')

    await tile(page).getByRole('button', { name: /^Viewport/ }).click()
    await expect(page.getByRole('menu', { name: 'Viewport' })).toBeVisible()
    await expect.poll(() => shown(app)).toEqual([false]) // an app popover hides the page
    await snap(app, 'tile-viewport-menu.png')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Viewport' })).toHaveCount(0)
    await expect(tile(page).getByRole('button', { name: /^Viewport/ })).toBeFocused()

    const widths: Record<string, number> = {}
    for (const [name, w] of [['Mobile', 390], ['Tablet', 768], ['Desktop', 1440]] as const) {
      await viewport(page, name)
      await expect(tile(page).getByRole('button', { name: /^Viewport/ })).toHaveText(new RegExp(`^${w}`))
      await expect.poll(async () => Math.abs((await innerW(app)) - w), { timeout: 10_000 }).toBeLessThanOrEqual(1)
      widths[name] = await innerW(app)
      await expect.poll(() => shown(app)).toEqual([true])
      if (name === 'Mobile') await snap(app, 'tile-mobile.png')
    }
    console.log('innerWidth per preset', JSON.stringify(widths))
    await viewport(page, 'Fit')
    await expect(tile(page).getByRole('button', { name: /^Viewport/ })).toHaveText(/^Fit/)
    await expect.poll(async () => Math.abs((await innerW(app)) - 1024), { timeout: 10_000 }).toBeLessThanOrEqual(1)
    await clean(page, errors)
  } finally {
    await app.close()
    await s.close()
  }
})

test('in a 1280x800 window the page is shown cut to the free area; a narrow preset is centred in the tile', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))
    await expect.poll(() => page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe('1280x800')
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await expect.poll(() => shown(app)).toEqual([true])
    // pan the board left so the tile runs past the free area
    await page.mouse.move(100, 70)
    await page.mouse.down()
    await page.mouse.move(40, 70, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => shown(app)).toEqual([true])
    const b = await bodyBox(page)
    const [f] = await frames(app)
    expect(f!.clip.x).toBeGreaterThanOrEqual(76 - 1)
    expect(f!.clip.x + f!.clip.width).toBeLessThanOrEqual(Math.min(b.x + b.width, 1280 - 24) + 2)
    expect(f!.clip.y + f!.clip.height).toBeLessThanOrEqual(b.y + b.height + 2)
    expect(Math.abs(f!.clip.x + f!.page!.x - b.x)).toBeLessThanOrEqual(2) // the page keeps the body's place and size
    expect(Math.abs(f!.page!.width - b.width)).toBeLessThanOrEqual(2)

    await viewport(page, 'Mobile')
    await expect.poll(async () => Math.abs((await innerW(app)) - 390)).toBeLessThanOrEqual(1)
    const nb = await bodyBox(page)
    const [m] = await frames(app)
    expect(m!.page!.width).toBe(390)
    expect(Math.abs(m!.clip.x + m!.page!.x + 195 - (nb.x + nb.width / 2))).toBeLessThanOrEqual(2) // centred in the body
  } finally {
    await app.close()
    await s.close()
  }
})

test('the viewport preset is saved with the board and restored on reopen', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const r = setupRepo()
  const home = tempDir('nodshell-e2e-home-')
  const env = { ...r.env, HOME: home, NODSHELL_USER_DATA: join(home, 'userdata'), NODSHELL_TEST_RESTORE: 'resume' }
  let { app, page } = await launch(env)
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await viewport(page, 'Tablet')
    await expect.poll(async () => Math.abs((await innerW(app)) - 768)).toBeLessThanOrEqual(1)
    await page.waitForTimeout(1200)
    await app.close()

    ;({ app, page } = await launch(env))
    await expect(tile(page)).toHaveCount(1)
    await expect(tile(page).getByRole('button', { name: /^Viewport/ })).toHaveText(/^768/)
    await expect.poll(() => shown(app)).toEqual([true])
    await expect.poll(async () => Math.abs((await innerW(app)) - 768)).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
    await s.close()
  }
})

test('focus mode: button, double-click and Ctrl+Shift+F fill the free area and restore the same place; Esc restores; one maximized node at a time', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const { app, page } = await launch()
  try {
    await newConsole(page, 1)
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await settled(page)
    await expect.poll(() => shown(app)).toEqual([true])
    const before = await nodeBox(page)
    const vp = await page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform)
    const head = tile(page).locator('.card-head')
    const inFocus = async () => {
      await expect(tile(page)).toHaveAttribute('data-maximized', 'true')
      await expect.poll(() => shown(app)).toEqual([true])
      const b = await bodyBox(page)
      const [f] = await frames(app)
      // the page fills the free area (inside the margins, under the title bar and nav row) at zoom 1
      expect(b.width).toBeGreaterThan(1300)
      expect(f!.clip.width).toBe(f!.page!.width)
      expect(Math.abs((await innerW(app)) - b.width)).toBeLessThanOrEqual(1)
    }
    const restored = async () => {
      await expect(tile(page)).not.toHaveAttribute('data-maximized', 'true')
      expect(await nodeBox(page)).toEqual(before)
      expect(await page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform)).toBe(vp)
      await expect.poll(() => shown(app)).toEqual([true])
    }

    await tile(page).getByRole('button', { name: 'Focus mode' }).click()
    await inFocus()
    await snap(app, 'tile-focus.png')
    await tile(page).getByRole('button', { name: 'Leave focus mode' }).click()
    await restored()

    await head.dblclick({ position: { x: 150, y: 12 } })
    await inFocus()
    await head.dblclick({ position: { x: 150, y: 12 } })
    await restored()

    await head.click({ position: { x: 150, y: 12 } }) // selects the tile
    await page.keyboard.press('Control+Shift+F')
    await inFocus()
    await page.keyboard.press('Control+Shift+F')
    await restored()

    await head.click({ position: { x: 150, y: 12 } })
    await page.keyboard.press('Control+Shift+F')
    await inFocus()
    await page.keyboard.press('Escape')
    await restored()

    // a maximized terminal hides the page; with the tile maximized the page shows
    await page.getByRole('button', { name: /^Maximize / }).click()
    await expect.poll(() => shown(app)).toEqual([false])
    await page.getByRole('button', { name: /^Restore / }).click()
    await expect.poll(() => shown(app)).toEqual([true])
  } finally {
    await app.close()
    await s.close()
  }
})

test('a tile maximized by keyboard is on top of a selected card', async () => {
  test.setTimeout(90_000)
  const s = await site()
  const { app, page } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await newConsole(page, 1)
    await page.getByTestId('terminal-node').locator('.card-head').click({ position: { x: 4, y: 4 }, force: true }) // the card is selected
    await tile(page).getByRole('textbox', { name: 'Address' }).focus()
    await page.keyboard.press('Control+Shift+F')
    await expect(tile(page)).toHaveAttribute('data-maximized', 'true')
    for (const sel of ['.card-head', '.tile-nav']) {
      const top = await tile(page).locator(sel).evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return hit !== null && el.contains(hit)
      })
      expect(top, sel).toBe(true)
    }
  } finally {
    await app.close()
    await s.close()
  }
})

test('Ctrl+Shift+F means one thing: restore what is maximized, else the node with focus inside, else the single selected node; one maximized at a time', async () => {
  test.setTimeout(120_000)
  const s = await site()
  const { app, page } = await launch()
  try {
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    await newConsole(page, 1) // after the tile, so it lands in a free spot and not under it
    const card = page.getByTestId('terminal-node')
    const max =(loc: Locator) => expect(loc).toHaveAttribute('data-maximized', 'true')
    const rest = (loc: Locator) => expect(loc).not.toHaveAttribute('data-maximized', 'true')
    const head = tile(page).locator('.card-head')

    // tile selected as well, keyboard focus inside the terminal: the chord takes the TERMINAL (an unselected card shows a summary, so the console stays selected)
    await card.locator('.card-head').click({ position: { x: 4, y: 4 }, force: true })
    await head.click({ position: { x: 150, y: 12 }, modifiers: ['Control'] })
    await card.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+Shift+F')
    await max(card)
    await rest(tile(page))
    await page.keyboard.press('Control+Shift+F') // restores, and does not maximize the tile in the same press
    await rest(card)
    await rest(tile(page))

    // only the tile selected, focus on the board: the chord takes the tile; while it is maximized the card is not
    await head.click({ position: { x: 150, y: 12 } })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+Shift+F')
    await max(tile(page))
    await rest(card)
    await page.keyboard.press('Control+Shift+F')
    await rest(tile(page))
    await rest(card)
  } finally {
    await app.close()
    await s.close()
  }
})

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { alive, cleanupTemp, launch, newConsole, readFile, tempDir, typeIn } from './helpers'
import { openRepo, setupRepo } from './repo'

test.afterEach(cleanupTemp)

/** A local site made by the test: a page with a title, a link to a local file, a redirect to one, a popup and a download. */
async function site() {
  let content = { title: 'Preview One', body: 'first version' }
  const srv = createServer((req, res) => {
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
/** Whether each tile's native view is shown over the window. */
const shown = (app: ElectronApplication) => app.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0]!.contentView.children.filter((v) => v instanceof WebContentsView).map((v) => v.getVisible()))

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
      await head.getByRole('button', { name: 'Edit address' }).click()
      const field = head.getByRole('textbox', { name: 'Address' })
      await field.fill(bad)
      await field.press('Enter')
      await expect(page.getByRole('alert')).toContainText('Only http and https addresses are allowed')
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await field.press('Escape')
      await expect(field).toHaveCount(0)
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

test('the native page hides under a dialog, a maximized card and the bottom bar, and comes back; closing a tile never touches a console', async () => {
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
    await page.waitForTimeout(300)
    expect(await shown(app)).toEqual([false])
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
  const home = tempDir('agent-canvas-e2e-home-')
  const env = { ...r.env, HOME: home, AGENT_CANVAS_USER_DATA: join(home, 'userdata'), AGENT_CANVAS_TEST_RESTORE: 'resume' }
  let { app, page, errors } = await launch(env)
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await openTile(page, s.url)
    await expect(title(page)).toHaveText('Preview One')
    // somewhere else on the page: about:blank is allowed, the next address is what is saved
    await tile(page).getByRole('button', { name: 'Edit address' }).click()
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

    const edit = tile(page).getByRole('button', { name: 'Edit address' })
    await edit.focus()
    await page.keyboard.press('Enter')
    const address = tile(page).getByRole('textbox', { name: 'Address' })
    await expect(address).toBeFocused()
    await expect(address).toHaveValue(s.url)
    await page.keyboard.type('nowhere')
    await page.keyboard.press('Escape')
    await expect(address).toHaveCount(0)
    await expect(edit).toBeFocused()
    expect((await pages(app)).map((p) => p.url)).toEqual([s.url])
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+A')
    await page.keyboard.type(`${s.url}other`)
    await page.keyboard.press('Enter')
    await expect(title(page)).toHaveText('Other page')
    await expect(edit).toBeFocused()

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
    const viewBox = () => app.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows()[0]!.contentView.children.find((v) => v instanceof WebContentsView)!.getBounds())
    const body = () => page.locator('[data-tile-body]').evaluate((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number })
    const close = (a: number, b: number) => Math.abs(a - b) <= 1.5
    let css = await body()
    let v = await viewBox()
    expect([close(v.x, css.x), close(v.y, css.y), close(v.width, css.width), close(v.height, css.height)]).toEqual([true, true, true, true])
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

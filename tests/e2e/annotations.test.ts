import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { png } from '../support/images'
import { cleanupTemp, launch, newConsole, tempDir } from './helpers'
import { openRepo, setupRepo, spawnAgent } from './repo'

test.afterEach(cleanupTemp)

type Launched = Awaited<ReturnType<typeof launch>>
const items = (page: Page) => page.locator('[data-testid=annotation-layer] .annotation-item')
const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Board tools' }).getByRole('button', { name, exact: true })
const pressed = async (page: Page) => (await page.getByRole('toolbar', { name: 'Board tools' }).locator('[aria-pressed=true]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).sort()
const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform)
const idleSpot = { x: 760, y: 620 } // an empty part of the board at 1440x900, below the cards

/** What is on the board, as the user sees it: one line per annotation (kind, place, size, points, text, image). */
const snapshot = (page: Page) =>
  items(page).evaluateAll((els) =>
    els.map((el) => [el.getAttribute('aria-label'), el.getAttribute('style'), el.getAttribute('points'), el.textContent, el.querySelector('img')?.getAttribute('src')].join('|')),
  )

/** A real mouse click at a place inside an element: unlike locator.click it does not wait for the element to be the hit target. */
async function clickIn(page: Page, el: Locator, at: { x: number; y: number }): Promise<void> {
  const b = (await el.boundingBox())!
  await page.mouse.click(b.x + at.x, b.y + at.y)
}
const windowSize = (page: Page) => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))

async function drag(page: Page, from: [number, number], to: [number, number], via: [number, number][] = []): Promise<void> {
  await page.mouse.move(...from)
  await page.mouse.down()
  for (const p of via) await page.mouse.move(...p, { steps: 4 })
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
}

/** The same user-data dir and HOME on every launch: what one run saves, the next one finds. */
function persistent(extra: Record<string, string>) {
  const home = tempDir('nodshell-e2e-home-')
  return () => ({ ...extra, HOME: home, NODSHELL_USER_DATA: join(home, 'userdata'), NODSHELL_TEST_RESTORE: 'resume' })
}
const imagesDir = (tmp: string) => join(tmp, 'userdata', 'board-images')

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  expect(errors).toEqual([])
}

async function putOnClipboard(app: Launched['app'], file: Buffer): Promise<void> {
  await app.evaluate(({ clipboard, ClipboardItem }, b64) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' }) })]), file.toString('base64'))
}

test('acceptance: a stroke, a shape, a note, a picked image and a pasted image come back in place after quitting', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const dir = tempDir('nodshell-e2e-img-')
  const file = join(dir, 'orange.png')
  writeFileSync(file, png(60, 40))
  const env = persistent({ ...r.env, NODSHELL_TEST_IMAGE: file })
  const home = env()
  let { app, page, errors } = await launch(home)
  try {
    await openRepo(page)
    await newConsole(page, 1)
    // pen
    await tool(page, 'Pen').click()
    await page.mouse.move(700, 300)
    await page.mouse.down()
    await page.mouse.move(760, 360, { steps: 6 })
    // the stroke shows while it is drawn, before the pointer is released
    await expect.poll(async () => ((await items(page).first().getAttribute('points')) ?? '').split(' ').length).toBeGreaterThan(1)
    await page.mouse.move(900, 330, { steps: 6 })
    await page.mouse.move(820, 280, { steps: 6 })
    await page.mouse.up()
    await expect(items(page)).toHaveCount(1)
    // shape (rectangle by default)
    await tool(page, 'Shapes').click()
    await drag(page, [700, 450], [860, 540])
    await expect(page.getByRole('img', { name: 'Rectangle' })).toHaveCount(1)
    // text note: the click creates it already in edit mode; Enter is a new line; Esc ends it
    await tool(page, 'Text').click()
    await page.mouse.click(1000, 300)
    const editor = page.getByRole('textbox', { name: 'Text note' })
    await expect(editor).toBeFocused()
    await page.keyboard.type('Hello <b>board</b>')
    await page.keyboard.press('Enter')
    await page.keyboard.type('second line')
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    const note = page.locator('.annotation-text')
    await expect(note).toHaveText('Hello <b>board</b>\nsecond line') // plain text, never markup
    expect(await note.evaluate((el) => el.querySelector('b'))).toBeNull()
    // image by the file dialog (the test variable stands in for the dialog)
    await tool(page, 'Select').click()
    await tool(page, 'Image').click()
    await expect(page.getByRole('img', { name: 'Image' })).toHaveCount(1)
    await expect.poll(() => page.locator('[data-testid=annotation-layer] img').evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBe(60)
    // image pasted with Ctrl+V on the board
    await putOnClipboard(app, png(30, 50, [61, 220, 132]))
    await page.mouse.click(idleSpot.x, idleSpot.y)
    await page.keyboard.press('Control+V')
    await expect(page.getByRole('img', { name: 'Image' })).toHaveCount(2)
    await expect.poll(() => page.locator('[data-testid=annotation-layer] img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth))).toEqual([60, 30])
    // the pasted one is selected: move it with the arrow keys, then drag the picked one aside
    await page.keyboard.press('Shift+ArrowRight')
    await page.getByRole('img', { name: 'Image' }).first().dragTo(page.locator('.react-flow__pane'), { sourcePosition: { x: 10, y: 10 }, targetPosition: { x: 1100, y: 500 } })
    await page.mouse.click(idleSpot.x, idleSpot.y + 100) // nothing selected
    await expect(items(page)).toHaveCount(5)
    expect(readdirSync(imagesDir(home.HOME))).toHaveLength(2)
    const before = await snapshot(page)
    const vpBefore = await viewport(page)
    await page.waitForTimeout(1200) // saved 500 ms after the last change
    await clean(page, errors)
    await page.screenshot({ path: test.info().outputPath('annotations-before.png') })
    await app.close()

    ;({ app, page, errors } = await launch(home))
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await expect(items(page)).toHaveCount(5)
    expect(await snapshot(page)).toEqual(before)
    expect(await viewport(page)).toBe(vpBefore)
    await expect.poll(() => page.locator('[data-testid=annotation-layer] img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth))).toEqual([60, 30])
    expect(readdirSync(imagesDir(home.HOME))).toHaveLength(2)
    await clean(page, errors)

    // Delete removes the focused annotation and its file; the other workspace-wide state is untouched
    await page.getByRole('img', { name: 'Image' }).first().focus()
    await page.keyboard.press('Delete')
    await expect(items(page)).toHaveCount(4)
    await expect.poll(() => readdirSync(imagesDir(home.HOME)).length).toBe(1)
    await page.waitForTimeout(1200)
    await app.close()
    ;({ app, page, errors } = await launch(home))
    await expect(items(page)).toHaveCount(4)
    expect(readdirSync(imagesDir(home.HOME))).toHaveLength(1)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('a board with only drawings (no terminals) comes back with them; Empty board throws them and the image files away', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const dir = tempDir('nodshell-e2e-img-')
  const file = join(dir, 'a.png')
  writeFileSync(file, png(20, 20))
  const env = persistent({ ...r.env, NODSHELL_TEST_IMAGE: file })
  const home = env()
  let { app, page } = await launch(home)
  try {
    await openRepo(page)
    await tool(page, 'Pen').click()
    await drag(page, [700, 300], [900, 330], [[760, 360]])
    await tool(page, 'Select').click()
    await tool(page, 'Image').click()
    await expect(items(page)).toHaveCount(2)
    const before = await snapshot(page)
    await page.waitForTimeout(1200)
    await app.close()
    const second = await launch(home)
    ;({ app, page } = second)
    await expect(items(page)).toHaveCount(2)
    expect(await snapshot(page)).toEqual(before)
    await clean(page, second.errors)
    await app.close()
    // Empty board only asks when there are terminals: with none, the drawings stay. Add a console, quit, choose "empty".
    ;({ app, page } = await launch(home))
    await newConsole(page, 1)
    await page.waitForTimeout(1200)
    await app.close()
    ;({ app, page } = await launch({ ...home, NODSHELL_TEST_RESTORE: 'empty' }))
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(items(page)).toHaveCount(0)
    await expect(page.getByTestId('terminal-node')).toHaveCount(0)
    await expect.poll(() => readdirSync(imagesDir(home.HOME)).length).toBe(0)
    await page.waitForTimeout(1200)
    await app.close()
    ;({ app, page } = await launch(home))
    await expect(items(page)).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('a drawing tool keeps clicks and keys away from terminals; Esc gives them back; the wheel still zooms', async () => {
  test.setTimeout(90_000)
  const { app, page, errors } = await launch()
  try {
    await newConsole(page, 1)
    const body = page.getByTestId('terminal-body').first()
    const field = page.locator('.xterm-helper-textarea').first()
    await body.click()
    await expect(field).toBeFocused()

    await tool(page, 'Pen').click() // by mouse: the focus leaves the terminal
    await expect(tool(page, 'Pen')).toHaveAttribute('aria-pressed', 'true')
    await expect(field).not.toBeFocused()
    await clickIn(page, body, { x: 100, y: 60 }) // lands on the drawing surface, not on the terminal (a locator click would wait forever for the terminal to be the target)
    await expect(field).not.toBeFocused()
    await expect(items(page)).toHaveCount(1) // a tap with the pen is a dot
    await page.keyboard.type('12345')
    await field.focus({ timeout: 2000 }).catch(() => undefined)
    await page.keyboard.type('67890') // even a terminal forced into focus gets nothing while a tool is active
    await page.mouse.move(800, 500)
    const vp = await viewport(page)
    await page.mouse.wheel(0, -400)
    await expect.poll(() => viewport(page)).not.toBe(vp)

    await page.keyboard.press('Escape')
    await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
    await expect(tool(page, 'Pen')).toHaveAttribute('aria-pressed', 'false')
    await body.click()
    await expect(field).toBeFocused()
    await page.keyboard.type('echo BACK-AGAIN')
    await page.keyboard.press('Enter')
    await expect(body).toContainText('BACK-AGAIN')
    await expect(body).not.toContainText('12345')
    await expect(body).not.toContainText('67890')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('the eraser removes an annotation and never a card', async () => {
  test.setTimeout(90_000)
  const { app, page, errors } = await launch()
  try {
    await newConsole(page, 1)
    await tool(page, 'Pen').click()
    await drag(page, [700, 300], [900, 300])
    await tool(page, 'Shapes').click()
    await drag(page, [700, 450], [860, 540])
    await expect(items(page)).toHaveCount(2)
    await tool(page, 'Eraser').click()
    // over the terminal: nothing is erased and the card stays
    await clickIn(page, page.getByTestId('terminal-body').first(), { x: 100, y: 60 })
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await expect(items(page)).toHaveCount(2)
    // a click on the stroke erases it; dragging across the shape erases it too
    await page.mouse.click(800, 300)
    await expect(items(page)).toHaveCount(1)
    await drag(page, [680, 500], [880, 500])
    await expect(items(page)).toHaveCount(0)
    await expect(page.getByTestId('terminal-node')).toHaveCount(1)
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('toolbar: arrow keys, one tab stop, single-key shortcuts only on the board, exclusive pressed state, web tile popover, Enter and arrows without the mouse', async () => {
  test.setTimeout(90_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    const bar = page.getByRole('toolbar', { name: 'Board tools' })
    await expect(bar).toHaveAttribute('aria-orientation', 'vertical')
    await expect(bar.getByRole('button')).toHaveText(['', '', '', '', '', '', '', '', '', ''])
    await expect(bar.getByRole('button')).toHaveCount(10)
    const names = await bar.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(names).toEqual(['Select', 'Add agents', 'Shapes', 'Web tile', 'Text', 'Pen', 'Eraser', 'Color', 'Image', 'Fit to content'])
    expect(await bar.locator('[tabindex="0"]').count()).toBe(1) // one tab stop
    expect(await pressed(page)).toEqual(['Select'])

    // arrows, Home, End; every key moves the one tab stop
    await tool(page, 'Select').focus()
    await page.keyboard.press('ArrowDown')
    await expect(tool(page, 'Add agents')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(tool(page, 'Shapes')).toBeFocused()
    await page.keyboard.press('End')
    await expect(tool(page, 'Fit to content')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(tool(page, 'Select')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(tool(page, 'Fit to content')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(tool(page, 'Select')).toBeFocused()
    await expect(tool(page, 'Select')).toHaveAttribute('tabindex', '0')
    await expect(tool(page, 'Pen')).toHaveAttribute('tabindex', '-1')

    // web tile (F12): opens its address popover, which is not a mode; Esc closes it
    const web = tool(page, 'Web tile')
    await expect(web).not.toHaveAttribute('aria-disabled', 'true')
    await expect(web).toHaveAccessibleDescription(/live page/)
    await web.click()
    await expect(page.getByRole('dialog', { name: 'New web tile' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'New web tile' })).toHaveCount(0)
    expect(await pressed(page)).toEqual(['Select'])
    // without a repository the agents button is disabled too, with the reason
    await expect(tool(page, 'Add agents')).toHaveAttribute('aria-disabled', 'true')
    await expect(tool(page, 'Add agents')).toHaveAccessibleDescription(/Open a repository first/)

    // tool letters, with the focus on the board
    await page.mouse.click(idleSpot.x, idleSpot.y)
    for (const [key, name] of [['p', 'Pen'], ['e', 'Eraser'], ['r', 'Shapes'], ['t', 'Text'], ['v', 'Select']] as const) {
      await page.keyboard.press(key)
      expect(await pressed(page), key).toEqual([name])
    }
    await page.keyboard.press('p')
    await page.keyboard.press('Escape')
    expect(await pressed(page)).toEqual(['Select'])
    // R again switches the shape
    await page.keyboard.press('r')
    await expect(tool(page, 'Shapes')).toHaveAccessibleDescription(/rectangle, press again for ellipse/)
    await page.keyboard.press('r')
    await expect(tool(page, 'Shapes')).toHaveAccessibleDescription(/ellipse, press again for rectangle/)
    await page.keyboard.press('Escape')

    // Enter on the board creates the item in the middle of the view; arrows move it; Delete removes it
    await page.mouse.click(idleSpot.x, idleSpot.y)
    await page.keyboard.press('r')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('img', { name: 'Ellipse' })).toHaveCount(1)
    await page.keyboard.press('Escape')
    const rect = page.getByRole('img', { name: 'Ellipse' })
    await rect.focus()
    const left = async () => Number(((await rect.getAttribute('style')) ?? '').match(/left: (-?[\d.]+)px/)?.[1])
    const x0 = await left()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    expect(await left()).toBeCloseTo(x0 + 12)
    await page.keyboard.press('Delete')
    await expect(items(page)).toHaveCount(0)
    await page.mouse.click(idleSpot.x, idleSpot.y)
    await page.keyboard.press('t')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Text note' })).toBeFocused()
    await page.keyboard.type('keyboard note')
    await page.keyboard.press('Escape')
    await expect(page.locator('.annotation-text')).toHaveText('keyboard note')
    await page.keyboard.press('Escape')

    // letters never switch tools from a terminal, a field or a button
    await newConsole(page, 1)
    await page.getByTestId('terminal-body').first().click()
    await page.keyboard.type('perv')
    expect(await pressed(page)).toEqual(['Select'])
    const command = page.getByRole('combobox', { name: 'Command', exact: true })
    await command.focus()
    await page.keyboard.type('pe')
    expect(await pressed(page)).toEqual(['Select'])
    await expect(command).toHaveValue('pe')
    await tool(page, 'Image').focus()
    await page.keyboard.press('p')
    expect(await pressed(page)).toEqual(['Select'])

    // the colour palette: a labelled dialog, Esc closes it and gives the focus back
    await tool(page, 'Color').click()
    const palette = page.getByRole('dialog', { name: 'Annotation color' })
    await expect(palette.getByRole('button')).toHaveCount(8)
    await expect(palette.getByRole('button', { name: 'Orange' })).toHaveAttribute('aria-pressed', 'true')
    await palette.getByRole('button', { name: 'Cyan' }).click()
    await expect(palette).toHaveCount(0)
    await expect(tool(page, 'Color')).toBeFocused()
    await tool(page, 'Color').click()
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await tool(page, 'Shapes').click()
    await drag(page, [700, 450], [860, 540])
    await expect(page.getByRole('img', { name: 'Ellipse' })).toHaveCSS('border-color', 'rgb(76, 201, 240)')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('Add agents opens the Spawn popover; Fit to content frames the whole board clear of the toolbar', async () => {
  test.setTimeout(90_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await tool(page, 'Add agents').click()
    await expect(page.getByRole('dialog', { name: 'Spawn agents' })).toBeVisible()
    await expect(tool(page, 'Add agents')).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Spawn agents' })).toHaveCount(0)
    await expect(tool(page, 'Add agents')).toBeFocused() // back to where it came from

    // nothing on the board: Fit is disabled with its reason
    await expect(tool(page, 'Fit to content')).toHaveAttribute('aria-disabled', 'true')
    await newConsole(page, 1)
    await page.getByRole('button', { name: 'New console' }).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(2)
    await tool(page, 'Pen').click()
    await drag(page, [1100, 600], [1300, 640])
    await tool(page, 'Select').click()
    await drag(page, [900, 700], [400, 300]) // pan the board away (empty spot, select tool)
    await tool(page, 'Fit to content').click()
    const win = await windowSize(page)
    const tb = (await tool(page, 'Select').boundingBox())!
    for (const n of await page.getByTestId('terminal-node').all()) {
      const b = (await n.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(tb.x + tb.width) // not behind the toolbar
      expect(b.x + b.width).toBeLessThanOrEqual(win.width)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.height).toBeLessThanOrEqual(win.height)
    }
    const stroke = (await page.getByRole('img', { name: 'Pen stroke' }).boundingBox())!
    expect(stroke.x + stroke.width).toBeLessThanOrEqual(win.width) // the drawing is part of the content
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('a squad with annotations behind it; a maximized card clears the toolbar; screenshot', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.getByTestId('orchestrator-node')).toBeVisible()
    await expect(page.getByTestId('group-node')).toHaveCount(4)
    await page.waitForTimeout(600)
    // a stroke and a note in the free centre column, a shape that starts above the Frontend group and runs under it
    const frame = (name: string) => page.locator(`[data-testid=group-node][data-name="${name}"] .group-frame`).boundingBox().then((b) => b!)
    const [fe, be, te] = [await frame('Frontend'), await frame('Backend'), await frame('Testers')]
    const mid = (fe.x + fe.width + be.x) / 2
    await tool(page, 'Pen').click()
    await drag(page, [mid - 130, fe.y + 22], [mid + 130, fe.y + 22], [[mid - 60, fe.y + 50], [mid + 10, fe.y + 10]])
    await tool(page, 'Shapes').click()
    await drag(page, [fe.x + 120, fe.y - 70], [fe.x + 300, fe.y + 90])
    await tool(page, 'Text').click()
    await page.mouse.click(mid - 100, te.y + te.height - 70)
    await page.keyboard.type('check the plan')
    await page.keyboard.press('Escape')
    await expect(items(page)).toHaveCount(3)
    // behind the cards: at a spot where the shape runs under the group, the group is what the pointer hits
    const hit = await page.evaluate(([x, y]) => document.elementsFromPoint(x!, y!).map((e) => e.className?.toString?.() ?? '').filter(Boolean), [fe.x + 200, fe.y + 40])
    const iShape = hit.findIndex((c) => c.includes('annotation-item'))
    const iNode = hit.findIndex((c) => c.includes('react-flow__node'))
    expect(iShape).toBeGreaterThanOrEqual(0)
    expect(iNode).toBeGreaterThanOrEqual(0)
    expect(iNode).toBeLessThan(iShape)
    await page.mouse.click(700, 150) // nothing selected for the picture
    await tool(page, 'Fit to content').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: test.info().outputPath('f11.png') })
    // the Orchestrator's terminal, expanded, is not behind the toolbar
    await page.getByTestId('orchestrator-node').getByRole('button', { name: /^Open Orchestrator terminal/ }).click()
    const big = page.locator('[data-maximized=true]')
    await expect(big).toBeVisible()
    const tb = (await tool(page, 'Select').boundingBox())!
    expect((await big.boundingBox())!.x).toBeGreaterThanOrEqual(tb.x + tb.width)
    await page.keyboard.press('Escape')
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('a file named .png that holds SVG is refused with a notice; an empty clipboard says so; nothing is stored', async () => {
  test.setTimeout(60_000)
  const dir = tempDir('nodshell-e2e-img-')
  const file = join(dir, 'cat.png')
  writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')
  const home = persistent({ NODSHELL_TEST_IMAGE: file })()
  const { app, page } = await launch(home)
  try {
    await tool(page, 'Image').click()
    await expect(page.getByRole('alert')).toHaveText('Not a valid PNG, JPEG, WebP or GIF image.')
    await expect(items(page)).toHaveCount(0)
    expect(existsSync(imagesDir(home.HOME)) ? readdirSync(imagesDir(home.HOME)) : []).toEqual([])
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.mouse.click(idleSpot.x, idleSpot.y)
    await page.keyboard.press('Control+V')
    await expect(page.getByRole('alert')).toHaveText('No image in the clipboard.')
    await expect(items(page)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

const jfk = join(homedir(), '.local', 'share', 'whisper.cpp', 'src', 'samples', 'jfk.wav')

test('holding Space with the pen active records for the command bar and draws nothing', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(90_000)
  const dir = tempDir('nodshell-whisper-')
  const bin = join(dir, 'whisper-cli')
  writeFileSync(bin, `#!${process.execPath}\nlet n = 0, h = ''\nprocess.stdin.on('data', (d) => { n += d.length; if (!h) h = d.subarray(0, 4).toString() })\nprocess.stdin.on('end', () => process.stdout.write(h === 'RIFF' && n > 20000 ? ' review the code\\n' : 'bad ' + h + n))\n`)
  chmodSync(bin, 0o755)
  const model = join(dir, 'model.bin')
  writeFileSync(model, 'x')
  const { app, page, errors } = await launch({ NODSHELL_TEST_FAKE_MIC: jfk, NODSHELL_WHISPER_BIN: bin, NODSHELL_WHISPER_MODEL: model })
  try {
    const field = page.getByRole('combobox', { name: 'Command', exact: true })
    await expect(page.getByRole('button', { name: 'Dictate command' })).not.toHaveAttribute('aria-disabled', 'true')
    await tool(page, 'Pen').click()
    await page.mouse.move(idleSpot.x, idleSpot.y)
    await page.keyboard.down('Space')
    await expect(field).toHaveAttribute('placeholder', 'Listening…')
    await page.mouse.move(idleSpot.x + 100, idleSpot.y + 40, { steps: 5 }) // moving with the key held is not drawing
    await page.waitForTimeout(1500)
    await page.keyboard.up('Space')
    await expect(field).toHaveValue('review the code', { timeout: 30_000 })
    await expect(items(page)).toHaveCount(0)
    await expect(tool(page, 'Pen')).toHaveAttribute('aria-pressed', 'true') // still the pen
    await clean(page, errors)
  } finally {
    await app.close()
  }
})

test('drawings survive a restore where no terminal comes back; a save never deletes what was not loaded', async () => {
  test.setTimeout(120_000)
  const r = setupRepo()
  const home = persistent(r.env)()
  let { app, page } = await launch(home)
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await tool(page, 'Pen').click()
    await drag(page, [700, 300], [900, 330], [[760, 360]])
    await expect(items(page)).toHaveCount(1)
    await page.waitForTimeout(1200)
    await app.close()
    rmSync(join(home.HOME, 'userdata', 'worktrees'), { recursive: true, force: true }) // the agent's worktree is gone
    ;({ app, page } = await launch(home))
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByTestId('agent-node')).toHaveCount(0)
    await expect(items(page)).toHaveCount(1)
    await page.waitForTimeout(1500) // the renderer's layout save arrives: it must not delete the drawing
    await app.close()
    ;({ app, page } = await launch(home))
    await expect(items(page)).toHaveCount(1)
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('a save cannot use an image id main did not make for this window or the project; one tab stop for the whole layer, PageUp and PageDown walk it', async () => {
  test.setTimeout(90_000)
  const r = setupRepo()
  const home = persistent(r.env)()
  let { app, page } = await launch(home)
  try {
    await openRepo(page)
    // a valid image file nobody registered, and a save that tries to use it
    const stranger = '11111111-2222-4333-8444-555555555555'
    mkdirSync(imagesDir(home.HOME), { recursive: true })
    writeFileSync(join(imagesDir(home.HOME), `${stranger}.png`), png(10, 10))
    const ws = (await page.getByRole('tabpanel').getAttribute('aria-labelledby'))!.replace(/^tab-/, '')
    const shape = { id: '22222222-2222-4333-8444-555555555555', kind: 'shape', shape: 'rect', color: '#ff6a2b', x: 0, y: 0, w: 50, h: 50 } as const
    const foreign = { id: '33333333-2222-4333-8444-555555555555', kind: 'image', imageId: stranger, x: 0, y: 0, w: 50, h: 50 } as const
    await page.evaluate(([w, a, b]) => window.api.invoke('annotations:save', { workspaceId: w as string, items: [a, b] as never }), [ws, shape, foreign])
    await page.waitForTimeout(1200)
    await app.close()
    ;({ app, page } = await launch(home))
    await expect(page.getByTestId('repo-badge')).toHaveText('main')
    await expect(page.getByRole('img', { name: 'Image' })).toHaveCount(0)
    await expect(page.getByRole('img', { name: 'Rectangle' })).toHaveCount(1) // the valid item of the same save stayed
    await tool(page, 'Pen').click() // three drawings of its own for the tab-stop part
    for (const y of [300, 360, 420]) await drag(page, [700, y], [760, y])
    await tool(page, 'Select').click()

    const layer = page.locator('[data-testid=annotation-layer]')
    await expect(layer.locator('[tabindex="0"]')).toHaveCount(1)
    const stops = layer.locator('[data-annotation-id]')
    await expect(stops).toHaveCount(4)
    const idOf = () => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-id'))
    await layer.locator('[tabindex="0"]').focus()
    const last = await idOf()
    await page.keyboard.press('PageUp')
    const prev = await idOf()
    expect(prev).not.toBe(last)
    await expect(layer.locator('[tabindex="0"]')).toHaveCount(1) // the stop moved with the selection
    await page.keyboard.press('PageDown')
    expect(await idOf()).toBe(last)
  } finally {
    await app.close().catch(() => undefined)
  }
})

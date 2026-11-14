import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { alive, cleanupTemp, expectGone, launch, newConsole, readFile, typeIn } from './helpers'

test.afterEach(cleanupTemp)

test('isolation and API surface', async () => {
  const { app, page, errors } = await launch()
  try {
    await expect(page.getByRole('heading', { name: 'NodShell', includeHidden: true })).toBeAttached()
    expect(await page.evaluate(() => typeof require)).toBe('undefined')
    expect(await page.evaluate(() => typeof process)).toBe('undefined')
    expect(await page.evaluate(() => Object.keys(window.api).sort())).toEqual(['invoke', 'on'])

    const ok = await page.evaluate(() => window.api.invoke('ping', { message: 'hi' }))
    expect(ok.reply).toBe('pong: hi')
    const bad = await page.evaluate(() =>
      window.api.invoke('pty:resize', { id: 'x', cols: 80, rows: 24 } as never).then(() => 'resolved', () => 'rejected'),
    )
    expect(bad).toBe('rejected')
    const unknownEvent = await page.evaluate(() => { try { window.api.on('nope' as never, () => undefined); return 'ok' } catch { return 'rejected' } })
    expect(unknownEvent).toBe('rejected')
    const forged = await page.evaluate(() =>
      window.api.invoke('pty:write', { id: '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11', data: 'x' }).then(() => 'resolved', () => 'rejected'),
    )
    expect(forged).toBe('rejected')

    // inline script must not run under the CSP
    const inlineRan = await page.evaluate(() => {
      const el = document.createElement('script')
      el.textContent = 'window.__inline = true'
      document.body.appendChild(el)
      return (window as unknown as { __inline?: boolean }).__inline === true
    })
    expect(inlineRan).toBe(false)
    expect(errors.filter((e) => !/Executing inline script violates/.test(e))).toEqual([])
  } finally {
    await app.close()
  }
})

test('three independent terminals, resize, close kills, quit kills', async () => {
  test.setTimeout(90_000)
  const { app, page, tmp, errors } = await launch()
  let closed = false
  try {
    for (let i = 0; i < 3; i++) await newConsole(page, i + 1)

    // 1. three distinct shells on three distinct ttys
    for (let i = 0; i < 3; i++) await typeIn(page, i, `echo $$ > ${tmp}/pid${i}; tty > ${tmp}/tty${i}`)
    const pids = await Promise.all([0, 1, 2].map((i) => readFile(join(tmp, `pid${i}`))))
    const ttys = await Promise.all([0, 1, 2].map((i) => readFile(join(tmp, `tty${i}`))))
    expect(new Set(pids).size).toBe(3)
    expect(new Set(ttys).size).toBe(3)

    // 2. resize node 0 and compare what the shell sees with what xterm computed
    await typeIn(page, 0, `stty size > ${tmp}/size-before`)
    const before = (await readFile(join(tmp, 'size-before'))).split(' ').map(Number)
    await page.getByTestId('terminal-node').nth(0).locator('.drag-handle').click()
    const handle = page.locator('.react-flow__resize-control.handle.bottom.right').first()
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + 110, { steps: 8 })
    await page.mouse.up()
    const dom = () =>
      page.getByTestId('terminal-node').nth(0).evaluate((el) => {
        const rows = el.querySelectorAll('.xterm-rows > div').length
        const screen = el.querySelector('.xterm-screen')!.getBoundingClientRect().width
        const cell = el.querySelector('.xterm-char-measure-element')!.getBoundingClientRect().width / 32
        return [rows, Math.round(screen / cell)]
      })
    await expect.poll(async () => (await dom())[0], { timeout: 8000 }).toBeGreaterThan(before[0]!)
    await page.waitForTimeout(400) // debounce + SIGWINCH
    const [expRows, expCols] = await dom()
    await typeIn(page, 0, `stty size > ${tmp}/size-after`)
    const after = (await readFile(join(tmp, 'size-after'))).split(' ').map(Number)
    expect(after[0]).toBeGreaterThan(before[0]!)
    expect(after[1]).toBeGreaterThan(before[1]!)
    expect(after).toEqual([expRows, expCols])

    // Backspace in a focused terminal and with a selected node never removes the node
    await page.getByTestId('terminal-body').nth(1).click()
    await page.keyboard.press('Backspace')
    await page.getByTestId('terminal-node').nth(1).locator('.drag-handle').click()
    await page.keyboard.press('Backspace')
    await expect(page.getByTestId('terminal-node')).toHaveCount(3)

    // 3. close terminal 2 while a foreground child runs
    await typeIn(page, 2, `sh -c 'echo $$ > ${tmp}/child2; exec sleep 1000'`)
    const child = Number(await readFile(join(tmp, 'child2')))
    expect(alive(child)).toBe(true)
    await page.getByRole('button', { name: /^Close console-/ }).nth(2).click()
    await expect(page.getByTestId('terminal-node')).toHaveCount(2)
    await expectGone(Number(pids[2]), child)

    // exit on its own shows an exited state
    await typeIn(page, 1, 'exit')
    await expect(page.getByTestId('terminal-node').nth(1)).toHaveAttribute('data-status', 'exited')

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])

    // 4. quit with terminal 0 still open
    await app.close()
    closed = true
    await expectGone(Number(pids[0]), Number(pids[1]))
  } finally {
    if (!closed) await app.close()
  }
})

test('truecolor output keeps its color under the CSP', async () => {
  const { app, page, errors } = await launch()
  try {
    await newConsole(page, 1)
    // the typed command never contains the rendered word, so only the colored output can match
    await typeIn(page, 0, "printf '\\033[38;2;255;106;43m%s\\033[0m\\n' TRUE_ORANGE_$((1+1))")
    const body = page.getByTestId('terminal-body').nth(0)
    await expect(body).toContainText('TRUE_ORANGE_2')
    const color = await body.evaluate((el) => {
      const span = [...el.querySelectorAll('.xterm-rows span')].find((s) => s.textContent === 'TRUE_ORANGE_2')
      return span ? getComputedStyle(span).color : 'not found'
    })
    expect(color).toBe('rgb(255, 106, 43)')
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('flow control: a flood does not freeze the app', async () => {
  test.setTimeout(120_000)
  const { app, page, errors } = await launch()
  try {
    await newConsole(page, 1)
    await typeIn(page, 0, 'yes abcdefghijklmnopqrstuvwxyz | head -c 20000000; echo MARKER_$((1+2))')
    await page.waitForTimeout(1000) // flood in progress
    await newConsole(page, 2) // still responsive while the flood is being processed
    await expect(page.getByTestId('terminal-body').nth(0)).toContainText('MARKER_3', { timeout: 100_000 })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('screenshot with three terminals', async () => {
  const { app, page } = await launch()
  try {
    for (let i = 0; i < 3; i++) await newConsole(page, i + 1)
    for (let i = 0; i < 3; i++) await typeIn(page, i, `echo "console ${i + 1} ready"; ls --color=auto /etc | head -n 8`)
    await page.waitForTimeout(800)
    await page.screenshot({ path: test.info().outputPath('f1.png') })
  } finally {
    await app.close()
  }
})

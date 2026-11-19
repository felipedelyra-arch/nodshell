import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanupTemp, launch, screenOf, tempDir } from './helpers'
import { END, openRepo, setupRepo, spawnAgent, START, submissions, type Run } from './repo'

test.afterEach(cleanupTemp)

const field = (page: Page) => page.getByRole('combobox', { name: 'Command', exact: true })
const sentCount = (r: { runs(): Run[]; logs: string }, text: string) => r.runs().flatMap((x) => submissions(r.logs, x.pid)).filter((s) => s === `${START}${text}${END}`).length
const bodies = (page: Page) => page.getByTestId('terminal-body')
const screens = (page: Page) => page.locator('[data-testid=terminal-body]:visible, [data-testid=terminal-preview]') // the terminal, or its summary when the card is zoomed out

test('commands: @name, no @, @group, the squad field, suggestions, history and refusals', async () => {
  test.setTimeout(240_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 60_000 })
    const nameOf = (role: string) => page.getByTestId('agent-node').filter({ has: page.getByTestId('role-tag').filter({ hasText: new RegExp(`^${role}$`) }) }).first().getAttribute('data-name')
    const zoe = (await nameOf('frontend'))!
    const bar = field(page)
    const squadField = page.getByTestId('orchestrator-node').getByRole('combobox', { name: 'Command the squad' })

    // @name: only that agent
    await expect(bar).toHaveAttribute('placeholder', 'Hold space to speak · @ to direct…')
    await bar.fill(`@${zoe.toLowerCase()} do X`)
    await page.screenshot({ path: test.info().outputPath('f7.png') })
    await bar.press('Enter')
    await expect(screenOf(page.locator(`[data-testid=agent-node][data-name="${zoe}"]`))).toContainText('SUBMITTED 1')
    await expect(bar).toHaveValue('')
    await expect(bar).toBeFocused()
    expect(sentCount(r, 'do X')).toBe(1) // the prefix is stripped and nobody else got it
    await expect(screens(page).filter({ hasText: 'SUBMITTED' })).toHaveCount(1)

    // no @: the Orchestrator only
    await bar.fill('plan it')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const lead = r.runs().find((x) => x.cwd.endsWith('orchestrator-1'))!
    await expect.poll(() => submissions(r.logs, lead.pid).includes(`${START}plan it${END}`)).toBe(true)
    expect(sentCount(r, 'plan it')).toBe(1)

    // @GROUP: both members, nobody else
    await bar.fill('@testers run the suite')
    await bar.press('Enter')
    await expect.poll(() => sentCount(r, 'run the suite')).toBe(2)
    for (const x of r.runs().filter((x) => /tester-[12]$/.test(x.cwd))) expect(submissions(r.logs, x.pid)).toContain(`${START}run the suite${END}`)

    // the Orchestrator's own field: without @ only that Orchestrator; with @, its squad's agents
    await squadField.fill('squad level')
    await squadField.press('Enter')
    await expect.poll(() => submissions(r.logs, lead.pid).includes(`${START}squad level${END}`)).toBe(true)
    expect(sentCount(r, 'squad level')).toBe(1)
    await expect(squadField).toHaveValue('')
    await squadField.fill(`@${zoe} from the squad`)
    await squadField.press('Enter')
    await expect.poll(() => sentCount(r, 'from the squad')).toBe(1)

    // an unknown name is refused with the names that exist, and the text stays
    await bar.fill('@Nobody hello')
    await bar.press('Enter')
    await expect(page.getByRole('alert')).toContainText(/@Nobody No agent or group with that name\. Try: /)
    await expect(bar).toHaveValue('@Nobody hello')
    expect(sentCount(r, 'hello')).toBe(0)

    // suggestions: only while completing an @, by keyboard
    await bar.fill('')
    await bar.press('@')
    const list = page.getByRole('listbox', { name: 'Agents and groups' })
    await expect(list.getByRole('option')).toHaveCount(13) // 9 agents + 4 groups
    await bar.press('ArrowDown')
    await bar.press('Enter')
    await expect(list).toHaveCount(0)
    const chosen = (await bar.inputValue()).trim()
    expect(chosen).toMatch(/^@\S+$/)
    await bar.fill('@')
    await expect(list).toBeVisible()
    await bar.press('Escape')
    await expect(list).toHaveCount(0)
    await bar.fill('plain text')
    await expect(list).toHaveCount(0)
    await bar.fill('@te')
    await expect(list.getByRole('option')).toHaveCount(1) // Testers
    await bar.press('Tab')
    await expect(bar).toHaveValue('@Testers ')

    // history: the chevron fills the field and does not send
    await bar.fill('')
    const before = sentCount(r, 'plan it')
    await page.getByRole('button', { name: 'Show history' }).click()
    const menu = page.getByRole('menu', { name: 'Recent commands' })
    await expect(menu.getByRole('menuitem').first()).toHaveText(`@${zoe} from the squad`) // newest first
    // keyboard: the first item has the focus on open; arrows, Home/End; Esc closes and returns to the button
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem').nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem').last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show history' })).toBeFocused()
    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: 'plan it' }).click()
    await expect(bar).toHaveValue('plan it')
    expect(sentCount(r, 'plan it')).toBe(before)
    // ArrowUp on an empty field walks the history too
    await bar.fill('')
    await bar.press('ArrowUp')
    await expect(bar).toHaveValue(`@${zoe} from the squad`)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  } finally {
    await app.close()
  }
})

const jfk = join(homedir(), '.local', 'share', 'whisper.cpp', 'src', 'samples', 'jfk.wav')

/** A fake whisper-cli: answers with a fixed text only when it got a RIFF WAV with real audio on stdin. */
function fakeWhisper(delayMs = 0): { WHISPER_BIN: string; WHISPER_MODEL: string; dir: string } {
  const dir = tempDir('nodshell-whisper-')
  const bin = join(dir, 'whisper-cli')
  writeFileSync(bin, `#!${process.execPath}\nlet n = 0, h = ''\nprocess.stdin.on('data', (d) => { n += d.length; if (!h) h = d.subarray(0, 4).toString() })\nprocess.stdin.on('end', () => require('fs').writeFileSync(__dirname + '/bytes', String(n)) || setTimeout(() => process.stdout.write(require('fs').existsSync(__dirname + '/empty') ? '' : h === 'RIFF' && n > 20000 ? ' review the code\\n' : 'bad ' + h + n), ${delayMs}))\n`)
  chmodSync(bin, 0o755)
  const model = join(dir, 'model.bin')
  writeFileSync(model, 'x')
  return { WHISPER_BIN: bin, WHISPER_MODEL: model, dir }
}

test('dictation: the recording keeps the whole hold and a 300 ms tail; a tap is thrown away silently', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(120_000)
  const r = setupRepo()
  const w = fakeWhisper()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_FAKE_MIC: jfk, NODSHELL_WHISPER_BIN: w.WHISPER_BIN, NODSHELL_WHISPER_MODEL: w.WHISPER_MODEL })
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const bar = field(page)
    await expect(page.getByRole('button', { name: 'Dictate command' })).not.toHaveAttribute('aria-disabled', 'true')
    await page.locator('.react-flow__pane').click({ position: { x: 700, y: 600 } })
    // (b) a 100 ms tap: no transcription, no toast
    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(1500)
    expect(existsSync(join(w.dir, 'bytes'))).toBe(false)
    await expect(page.getByText(/catch that|microphone/i)).toHaveCount(0)
    await expect(bar).toHaveValue('')
    // (a) a 2 s hold: at least 2000 + 300 - 100 ms of 16 kHz 16-bit audio reaches the transcriber
    await page.keyboard.down('Space')
    await page.waitForTimeout(2000)
    await page.keyboard.up('Space')
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    const pcm = Number(readFileSync(join(w.dir, 'bytes'), 'utf8')) - 44
    expect(pcm).toBeGreaterThanOrEqual(70_400)
    // dictation only types
    await page.waitForTimeout(500)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('dictation: hold Space on the board writes into the field and never sends; Space in a terminal or a field does not record', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(120_000)
  const r = setupRepo()
  const w = fakeWhisper()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_FAKE_MIC: jfk, NODSHELL_WHISPER_BIN: w.WHISPER_BIN, NODSHELL_WHISPER_MODEL: w.WHISPER_MODEL })
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const bar = field(page)
    const idle = 'Hold space to speak · @ to direct…'
    await expect(page.getByRole('button', { name: 'Dictate command' })).not.toHaveAttribute('aria-disabled', 'true')

    // hold Space with the focus on the board
    await page.locator('.react-flow__pane').click({ position: { x: 700, y: 600 } })
    await page.keyboard.down('Space')
    await expect(bar).toHaveAttribute('placeholder', 'Speak now…')
    await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(1500)
    await page.keyboard.up('Space')
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    await expect(bar).toHaveAttribute('placeholder', idle)
    // dictation only types: nothing reached a terminal
    await page.waitForTimeout(500)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    await expect(screens(page).filter({ hasText: 'SUBMITTED' })).toHaveCount(0)

    // a quick tap is not a recording
    await page.locator('.react-flow__pane').click({ position: { x: 700, y: 600 } })
    await page.keyboard.down('Space')
    await page.waitForTimeout(80)
    await page.keyboard.up('Space')
    await page.waitForTimeout(500)
    await expect(bar).toHaveAttribute('placeholder', idle)
    await expect(bar).toHaveValue('review the code')

    // Space inside a terminal or the field keeps its meaning
    await bodies(page).first().click()
    await page.keyboard.down('Space')
    await page.waitForTimeout(600)
    await expect(bar).toHaveAttribute('placeholder', idle)
    await page.keyboard.up('Space')
    await bar.focus()
    await bar.press('End')
    await page.keyboard.down('Space')
    await page.waitForTimeout(600)
    await expect(bar).toHaveAttribute('placeholder', idle)
    await page.keyboard.up('Space')
    await expect(bar).toHaveValue('review the code ')

    // the microphone button: tap to start, tap to stop; the text is appended; still nothing sent
    const mic = page.getByRole('button', { name: 'Dictate command' })
    await mic.click()
    await expect(bar).toHaveAttribute('placeholder', 'Speak now…')
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Stop dictation' }).click()
    await expect(bar).toHaveValue('review the code review the code', { timeout: 30_000 })
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    // only the user's Enter sends it
    await bar.fill('review the code')
    await bar.press('Enter')
    // no Orchestrator and a single agent: it is the obvious recipient, no @ needed
    // (the Space typed into its terminal earlier in this test is still in its input line, before the paste)
    await expect.poll(() => r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([` ${START}review the code${END}`])
    await expect(bar).toHaveValue('')
    expect(errors).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  } finally {
    await app.close()
  }
})

test('target preview: shown before Enter in the bar and in the Orchestrator field, from main, and nothing is sent', async () => {
  test.setTimeout(240_000)
  const r = setupRepo()
  const { app, page, errors } = await launch(r.env)
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Small squad/ }).click()
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(5, { timeout: 60_000 })
    const zoe = (await page.getByTestId('agent-node').filter({ has: page.getByTestId('role-tag').filter({ hasText: /^frontend$/ }) }).first().getAttribute('data-name'))!
    const bar = field(page)
    const group = page.getByRole('group', { name: 'Command bar' })
    const target = group.getByTestId('command-target')
    const orch = page.getByTestId('orchestrator-node')
    const squadField = orch.getByRole('combobox', { name: 'Command the squad' })
    await expect(target).toHaveCount(0) // empty field: nothing

    await bar.fill(`@${zoe.toLowerCase()} do X`)
    await expect(target).toHaveText(`→ ${zoe}`)
    await expect(bar).toHaveAttribute('aria-describedby', (await target.getAttribute('id'))!)
    await bar.fill('@Frontend do X')
    await expect(target).toContainText('→ FRONTEND · ')
    await bar.fill('@Nobody hello')
    await expect(target).toContainText('@Nobody No agent or group with that name')
    await expect(target.locator('.is-error')).toHaveCount(1)
    await bar.fill('plan it')
    await expect(target).toHaveText('→ Orchestrator')
    await bar.fill('')
    await expect(target).toHaveCount(0)
    await expect(bar).not.toHaveAttribute('aria-describedby', /./)

    await squadField.fill('squad level')
    await expect(orch.getByTestId('command-target')).toHaveText('→ Orchestrator')
    await orch.screenshot({ path: test.info().outputPath('orchestrator-target.png') })
    await squadField.fill(`@${zoe} from the squad`)
    await expect(orch.getByTestId('command-target')).toHaveText(`→ ${zoe}`)
    await expect(target).toHaveCount(0) // the bar's own field is untouched

    // the preview is advisory: nothing was sent by any of it
    await page.waitForTimeout(500)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('dictation states are visible with text: listening with a level meter, transcribing, ready with the target, error; nothing is sent', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(180_000)
  const r = setupRepo()
  const w = fakeWhisper(1500)
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_FAKE_MIC: jfk, NODSHELL_WHISPER_BIN: w.WHISPER_BIN, NODSHELL_WHISPER_MODEL: w.WHISPER_MODEL })
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const name = (await page.getByTestId('agent-node').first().getAttribute('data-name'))!
    const bar = field(page)
    const group = page.getByRole('group', { name: 'Command bar' })
    const status = group.getByRole('status')
    const shot = (n: string, width: number) => page.screenshot({ path: test.info().outputPath(`${n}-${width}.png`), clip: { x: 0, y: 780, width, height: 120 } })
    const hold = async (ms: number) => {
      await page.locator('.react-flow__pane').click({ position: { x: 700, y: 600 } })
      await page.keyboard.down('Space')
      await expect(status).toHaveText('Listening…')
      await page.waitForTimeout(ms)
    }
    for (const width of [1440, 1280]) {
      await app.evaluate(({ BrowserWindow }, wd) => BrowserWindow.getAllWindows()[0]?.setSize(wd, 900), width)
      await page.waitForTimeout(400)
      await bar.fill('')
      rmSync(join(w.dir, 'empty'), { force: true })

      // recording: text, a level meter, and the same state during the 300 ms tail
      await hold(1000)
      await expect(group.getByTestId('level-meter')).toBeVisible()
      await shot('1-listening', width)
      await page.keyboard.up('Space')
      await expect(status).toHaveText('Listening…')
      // processing
      await expect(status).toHaveText('Transcribing…')
      await expect(group.getByTestId('level-meter')).toHaveCount(0)
      await shot('2-transcribing', width)
      // ready: the text is in the field, editable, with the target; nothing sent
      await expect(status).toHaveText('Dictated. Press Enter to send.', { timeout: 30_000 })
      await expect(bar).toHaveValue('review the code')
      await expect(group.getByTestId('command-target')).toHaveText(`→ ${name}`)
      await shot('3-ready-target', width)
      const box = await group.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
      expect(await group.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      expect((await bar.boundingBox())!.width).toBeGreaterThan(200)
      expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
      // typing dismisses the message
      await bar.press('End')
      await bar.pressSequentially('!')
      await expect(status).toHaveText('')
      // error: stays until the next dictation or typing
      writeFileSync(join(w.dir, 'empty'), '')
      await bar.fill('')
      await hold(600)
      await page.keyboard.up('Space')
      await expect(status).toHaveText("Didn't catch that.", { timeout: 30_000 })
      await expect(status).toHaveAttribute('data-kind', 'error')
      await shot('4-error', width)
      await bar.pressSequentially('a')
      await expect(status).toHaveText('')
      expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    }

    // reduced motion: a still recording mark instead of the animated meter
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await bar.fill('')
    await hold(300)
    await expect(group.getByTestId('rec-mark')).toBeVisible()
    await expect(group.getByTestId('level-meter')).toHaveCount(0)
    await page.keyboard.up('Space')
    await expect(status).toHaveText(/Transcribing…|Didn't catch that\./, { timeout: 30_000 })
    expect(errors).toEqual([])  } finally {
    await app.close()
  }
})

test('without whisper.cpp the microphones are disabled with a hint and Space does not record', async () => {
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_WHISPER_BIN: '/nonexistent/whisper-cli' })
  try {
    await openRepo(page)
    const mic = page.getByRole('button', { name: 'Dictate command' })
    await expect(mic).toHaveAttribute('aria-disabled', 'true')
    await expect(mic).toHaveAttribute('data-tip', 'Voice needs whisper.cpp in ~/.local/share/whisper.cpp')
    await page.locator('.react-flow__pane').click({ position: { x: 700, y: 600 } })
    await page.keyboard.down('Space')
    await page.waitForTimeout(600)
    await expect(field(page)).toHaveAttribute('placeholder', 'Hold space to speak · @ to direct…')
    await page.keyboard.up('Space')
    await mic.click({ force: true }) // aria-disabled: Playwright would wait for it to enable
    await expect(field(page)).toHaveAttribute('placeholder', 'Hold space to speak · @ to direct…')
    // video is never granted
    expect(await page.evaluate(() => Promise.race([navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e: Error) => e.name), new Promise((r) => setTimeout(() => r('hung'), 5000))]))).toMatch(/^(NotAllowedError|NotFoundError)$/) // never granted (the sandbox has no camera either)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('dictation: leaving the window ends a tap-started recording; the focus is not pulled from a terminal', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(120_000)
  const r = setupRepo()
  const w = fakeWhisper(2500)
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_FAKE_MIC: jfk, NODSHELL_WHISPER_BIN: w.WHISPER_BIN, NODSHELL_WHISPER_MODEL: w.WHISPER_MODEL })
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const bar = field(page)
    const mic = page.getByRole('button', { name: 'Dictate command' })
    // tap to start, then the window loses focus (Alt+Tab): the microphone closes and what was heard is transcribed
    await mic.click()
    await expect(bar).toHaveAttribute('placeholder', 'Speak now…')
    await page.waitForTimeout(1200)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(bar).toHaveAttribute('placeholder', 'Your words appear here…')
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    // while transcribing, the user goes to type in a terminal: the text still arrives, the focus stays, nothing is sent
    await bar.fill('')
    await mic.click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Stop dictation' }).click()
    await expect(bar).toHaveAttribute('placeholder', 'Your words appear here…')
    await bodies(page).first().click()
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    await expect(page.locator(':focus')).toHaveClass(/xterm-helper-textarea/)
    await page.waitForTimeout(300)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    // the visibility change closes it too
    await mic.click()
    await expect(bar).toHaveAttribute('placeholder', 'Speak now…')
    await page.waitForTimeout(1200)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(bar).toHaveAttribute('placeholder', 'Your words appear here…')
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('dictation: an Enter held or repeated across the transcription never sends the text', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(120_000)
  const r = setupRepo()
  const w = fakeWhisper(800)
  const { app, page, errors } = await launch({ ...r.env, NODSHELL_TEST_FAKE_MIC: jfk, NODSHELL_WHISPER_BIN: w.WHISPER_BIN, NODSHELL_WHISPER_MODEL: w.WHISPER_MODEL })
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const bar = field(page)
    const mic = page.getByRole('button', { name: 'Dictate command' })
    await mic.focus()
    await page.keyboard.press('Enter') // start (tap)
    await expect(bar).toHaveAttribute('placeholder', 'Speak now…')
    await page.waitForTimeout(1500)
    await page.keyboard.press('Enter') // stop (tap)
    await expect(bar).toHaveAttribute('placeholder', 'Your words appear here…')
    // the key stays down and auto-repeats while the text lands
    for (let i = 0; i < 25; i++) {
      await page.keyboard.down('Enter')
      await page.waitForTimeout(100)
    }
    await page.keyboard.up('Enter')
    await expect(bar).toHaveValue('review the code')
    await page.waitForTimeout(500)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    await expect(mic).toBeFocused() // the text was added without taking the focus from the button
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

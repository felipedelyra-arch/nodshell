import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cleanupTemp, launch, tempDir } from './helpers'
import { END, openRepo, setupRepo, spawnAgent, START, submissions, type Run } from './repo'

test.afterEach(cleanupTemp)

const field = (page: Page) => page.getByRole('combobox', { name: 'Command', exact: true })
const sentCount = (r: { runs(): Run[]; logs: string }, text: string) => r.runs().flatMap((x) => submissions(r.logs, x.pid)).filter((s) => s === `${START}${text}${END}`).length
const bodies = (page: Page) => page.getByTestId('terminal-body')

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
    await expect(page.locator(`[data-testid=agent-node][data-name="${zoe}"]`).getByTestId('terminal-body')).toContainText('SUBMITTED 1')
    await expect(bar).toHaveValue('')
    await expect(bar).toBeFocused()
    expect(sentCount(r, 'do X')).toBe(1) // the prefix is stripped and nobody else got it
    await expect(bodies(page).filter({ hasText: 'SUBMITTED' })).toHaveCount(1)

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
function fakeWhisper(delayMs = 0): { WHISPER_BIN: string; WHISPER_MODEL: string } {
  const dir = tempDir('agent-canvas-whisper-')
  const bin = join(dir, 'whisper-cli')
  writeFileSync(bin, `#!${process.execPath}\nlet n = 0, h = ''\nprocess.stdin.on('data', (d) => { n += d.length; if (!h) h = d.subarray(0, 4).toString() })\nprocess.stdin.on('end', () => setTimeout(() => process.stdout.write(h === 'RIFF' && n > 20000 ? ' review the code\\n' : 'bad ' + h + n), ${delayMs}))\n`)
  chmodSync(bin, 0o755)
  const model = join(dir, 'model.bin')
  writeFileSync(model, 'x')
  return { WHISPER_BIN: bin, WHISPER_MODEL: model }
}

test('dictation: hold Space on the board writes into the field and never sends; Space in a terminal or a field does not record', async () => {
  test.skip(!existsSync(jfk), 'the whisper.cpp sample is not installed')
  test.setTimeout(120_000)
  const r = setupRepo()
  const w = fakeWhisper()
  const { app, page, errors } = await launch({ ...r.env, AGENT_CANVAS_TEST_FAKE_MIC: jfk, AGENT_CANVAS_WHISPER_BIN: w.WHISPER_BIN, AGENT_CANVAS_WHISPER_MODEL: w.WHISPER_MODEL })
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
    await expect(bar).toHaveAttribute('placeholder', 'Listening…')
    await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(1500)
    await page.keyboard.up('Space')
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    await expect(bar).toHaveAttribute('placeholder', idle)
    // dictation only types: nothing reached a terminal
    await page.waitForTimeout(500)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    await expect(bodies(page).filter({ hasText: 'SUBMITTED' })).toHaveCount(0)

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
    await expect(bar).toHaveAttribute('placeholder', 'Listening…')
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Stop dictation' }).click()
    await expect(bar).toHaveValue('review the code review the code', { timeout: 30_000 })
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    // only the user's Enter sends it
    await bar.fill('review the code')
    await bar.press('Enter')
    await expect.poll(() => r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([]) // no Orchestrator: refused with the @name hint
    await expect(page.getByRole('alert')).toContainText('@name')
    expect(errors).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
  } finally {
    await app.close()
  }
})

test('without whisper.cpp the microphones are disabled with a hint and Space does not record', async () => {
  const r = setupRepo()
  const { app, page, errors } = await launch({ ...r.env, AGENT_CANVAS_WHISPER_BIN: '/nonexistent/whisper-cli' })
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
  const { app, page, errors } = await launch({ ...r.env, AGENT_CANVAS_TEST_FAKE_MIC: jfk, AGENT_CANVAS_WHISPER_BIN: w.WHISPER_BIN, AGENT_CANVAS_WHISPER_MODEL: w.WHISPER_MODEL })
  try {
    await openRepo(page)
    await spawnAgent(page, 'backend', 'sonnet', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 30_000 })
    const bar = field(page)
    const mic = page.getByRole('button', { name: 'Dictate command' })
    // tap to start, then the window loses focus (Alt+Tab): the microphone closes and what was heard is transcribed
    await mic.click()
    await expect(bar).toHaveAttribute('placeholder', 'Listening…')
    await page.waitForTimeout(1200)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(bar).toHaveAttribute('placeholder', 'Transcribing…')
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    // while transcribing, the user goes to type in a terminal: the text still arrives, the focus stays, nothing is sent
    await bar.fill('')
    await mic.click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Stop dictation' }).click()
    await expect(bar).toHaveAttribute('placeholder', 'Transcribing…')
    await bodies(page).first().click()
    await expect(bar).toHaveValue('review the code', { timeout: 30_000 })
    await expect(page.locator(':focus')).toHaveClass(/xterm-helper-textarea/)
    await page.waitForTimeout(300)
    expect(r.runs().flatMap((x) => submissions(r.logs, x.pid))).toEqual([])
    // the visibility change closes it too
    await mic.click()
    await expect(bar).toHaveAttribute('placeholder', 'Listening…')
    await page.waitForTimeout(1200)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(bar).toHaveAttribute('placeholder', 'Transcribing…')
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

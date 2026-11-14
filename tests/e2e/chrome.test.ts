import { expect, test } from '@playwright/test'
import { cleanupTemp, launch } from './helpers'
import { openRepo, setupRepo } from './repo'

test.afterEach(cleanupTemp)

test('chrome: top bar, pills, command bar, footer, dialogs', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const { app, page, tmp, errors } = await launch(r.env)
  try {
    // top left, in order; later-phase chips are disabled with a tip
    const items = page.getByRole('navigation', { name: 'Workspace' }).locator('button')
    await expect(items).toHaveText(['← Back to home', 'Open repository▾', 'Workspace 1', '+', '✕ Close'])
    for (const name of ['Back to home', 'New workspace']) await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveAttribute('aria-disabled', 'true') // home is a later phase; "+" needs a repository
    await expect(page.getByRole('button', { name: 'Close workspace' })).not.toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('tab', { name: 'Workspace 1' })).toHaveAttribute('aria-selected', 'true')

    // pills: seven, in order; Pause and Resume disabled while nothing runs (the tip shows on focus); Memory works (F8)
    await expect(page.locator('button.pill')).toHaveText(['New console', 'Spawn 4', 'Group', 'Presets', 'Pause all', 'Resume all', 'Memory'])
    await expect(page.getByRole('button', { name: 'Memory', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
    for (const name of ['Pause all', 'Resume all']) {
      const pill = page.getByRole('button', { name, exact: true }) // the tip is the description, not part of the name
      await expect(pill).toHaveAttribute('aria-disabled', 'true')
      await pill.focus()
      await expect.poll(() => pill.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1')
    }

    // command bar (F7): the field works; history, Send and the microphone are disabled with a reason (no commands yet, empty field, no whisper.cpp under the test's HOME)
    const input = page.getByRole('combobox', { name: 'Command', exact: true })
    await expect(input).toHaveAttribute('placeholder', 'Hold space to speak · @ to direct…')
    await expect(input).toBeEditable()
    const mic = page.getByRole('button', { name: 'Dictate command' })
    await mic.focus()
    await expect.poll(() => mic.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1')
    for (const name of ['Show history', 'Send', 'Dictate command']) await expect(page.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true')
    const bar = (await page.locator('.cmd-bar').boundingBox())!
    const pills = (await page.locator('button.pill').first().boundingBox())!
    const lastPill = (await page.locator('button.pill').last().boundingBox())!
    expect(bar.width).toBeGreaterThan(lastPill.x + lastPill.width - pills.x)
    expect(bar.y).toBeGreaterThan(pills.y + pills.height)

    // the worktree counter follows the live agents
    await openRepo(page)
    await expect(page.getByTestId('worktree-count')).toHaveText('· 0')
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await expect(page.getByTestId('worktree-count')).toHaveText('· 9')
    await page.waitForTimeout(500)
    await page.screenshot({ path: test.info().outputPath('c5.png') })
    const first = page.getByTestId('agent-node').first()
    const name = (await first.getAttribute('data-name'))!
    await first.getByRole('button', { name: `Close ${name}` }).click()
    await expect(page.getByTestId('worktree-count')).toHaveText('· 8')

    // Found a bug?: diagnostic without sensitive data, Copy, Esc, focus returns
    const bug = page.getByRole('button', { name: 'Found a bug?' })
    await bug.click()
    const dlg = page.getByRole('dialog', { name: 'Found a bug?' })
    await expect(dlg.getByLabel('Diagnostic')).toContainText('Process limit') // filled once the main process answers
    const text = (await dlg.getByLabel('Diagnostic').textContent()) ?? ''
    expect(text).toMatch(/Agent Canvas \S+\nElectron \S+ \/ Chromium \S+ \/ Node \S+\nPlatform: \w+ \w+\nProcesses: \d+\nAgents: \d+\nProcess limit: \d+/)
    for (const secret of [tmp, 'demo repo', r.repo]) expect(text).not.toContain(secret)
    await dlg.getByRole('button', { name: 'Copy' }).click()
    await expect(dlg.getByRole('status')).toHaveText('Copied')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text)
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
    await expect(bug).toBeFocused()

    // About: version and shortcuts, Esc closes, focus returns
    const info = page.getByRole('button', { name: 'About' })
    await info.click()
    const about = page.getByRole('dialog', { name: 'About' })
    await expect(about).toContainText('Agent Canvas')
    await expect(about).toContainText('Shift + click')
    // modal: the chrome behind it is covered
    expect(await page.locator('button.pill').first().evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el })).toBe(false)
    await page.keyboard.press('Escape')
    await expect(about).toHaveCount(0)
    await expect(info).toBeFocused()

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

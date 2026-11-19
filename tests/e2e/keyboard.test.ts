import { expect, test, type Page } from '@playwright/test'
import { cleanupTemp, launch } from './helpers'
import { setupRepo } from './repo'

test.afterEach(cleanupTemp)

type Focus = { key: string; label: string; ring: number; inBody: boolean }

/** What has the focus: a stable key for it, a readable label and the width of the focus indicator it shows (0 = none). */
const focused = (page: Page): Promise<Focus> =>
  page.evaluate(() => {
    const w = window as unknown as { __kb?: number }
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return { key: 'body', label: 'body', ring: 0, inBody: true }
    if (!el.dataset['kb']) el.dataset['kb'] = String((w.__kb = (w.__kb ?? 0) + 1))
    const cs = getComputedStyle(el)
    const label = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
    return { key: el.dataset['kb'], label, ring: cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth), inBody: false }
  })

/** Everything Tab should reach now: visible, not disabled, in the tab order (a roving group gives one stop). Inside `scope` when given. */
const tabbable = (page: Page, scope = 'body'): Promise<string[]> =>
  page.evaluate((sel) => {
    const out: string[] = []
    for (const el of document.querySelector(sel)?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]') ?? []) {
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || !el.checkVisibility({ checkVisibilityCSS: true })) continue
      out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`)
    }
    return out
  }, scope)

/** Presses `key` until the focus is back where it started; every stop must show its focus and none may hold the focus. */
async function cycle(page: Page, key: 'Tab' | 'Shift+Tab'): Promise<Focus[]> {
  const stops: Focus[] = []
  await page.keyboard.press(key)
  const first = await focused(page)
  let cur = first
  for (let i = 0; i < 200; i++) {
    expect(cur.ring, `focus is visible on ${cur.label}`).toBeGreaterThan(0)
    stops.push(cur)
    await page.keyboard.press(key)
    const next = await focused(page)
    expect(next.key, `${key} leaves ${cur.label}`).not.toBe(cur.key)
    if (next.key === first.key) return stops
    cur = next
  }
  throw new Error(`${key} never came back to ${first.label}: ${stops.slice(-6).map((s) => s.label).join(' → ')}`)
}

/** Tab until the control named `name` has the focus. */
async function tabTo(page: Page, name: string | RegExp): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const f = await focused(page)
    if (typeof name === 'string' ? f.label.includes(`"${name}`) : name.test(f.label)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab never reached ${String(name)}`)
}

test('keyboard only: every control is reached, shows its focus and lets it go; Esc gives the focus back to the opener', async () => {
  test.setTimeout(180_000)
  const r = setupRepo()
  const { app, page, tmp, errors } = await launch(r.env)
  try {
    // open the project and start a console, by keyboard
    await page.keyboard.press('Tab')
    await tabTo(page, 'Open folder')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('workspace-name')).not.toHaveText('Open folder')
    await tabTo(page, 'New console')
    await page.keyboard.press('Enter')
    const card = page.getByTestId('terminal-node')
    await expect(card).toHaveCount(1)

    // the terminal: Enter on its frame goes in, where every key (Tab too) is the shell's; F6 comes back out and Tab moves on
    const frame = card.getByTestId('terminal-body')
    await frame.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true)
    await page.keyboard.press('Tab')
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.xterm')), { message: 'Tab is typed into the terminal' }).toBe(true)
    await page.keyboard.press('F6')
    await expect(frame).toBeFocused()

    // the whole window, forwards: top bar → the card's controls and terminal → board tools → pills → command bar → footer
    const expected = await tabbable(page)
    const forward = await cycle(page, 'Tab')
    const seen = new Set(forward.map((s) => s.label))
    expect(expected.filter((l) => !seen.has(l)), 'controls Tab never reached').toEqual([])
    for (const part of ['Back to home', 'Workspace 1', 'Close workspace', 'About', 'Pin console-1', 'Maximize console-1', 'Close console-1', 'Terminal of console-1', 'Select', 'New console', 'Presets', 'Close all', 'Command', 'Show history', 'Send', 'Dictate command', 'Found a bug?']) {
      expect(forward.some((s) => s.label.includes(part)), `Tab reaches ${part}`).toBe(true)
    }
    // and backwards: the same stops
    const backward = await cycle(page, 'Shift+Tab')
    expect(new Set(backward.map((s) => s.key))).toEqual(new Set(forward.map((s) => s.key)))

    // board tools: one Tab stop, the arrows walk every tool
    const tools = page.getByRole('toolbar', { name: 'Board tools' }).getByRole('button')
    const toolCount = await tools.count()
    await tabTo(page, 'Select')
    const walked = new Set<string>()
    for (let i = 0; i < toolCount; i++) {
      const f = await focused(page)
      expect(f.ring, `focus is visible on ${f.label}`).toBeGreaterThan(0)
      walked.add(f.key)
      await page.keyboard.press('ArrowDown')
    }
    expect(walked.size).toBe(toolCount)

    // a card's controls: Space maximizes, Esc restores and the focus stays on the control
    await tabTo(page, 'Maximize console-1')
    await page.keyboard.press('Space')
    await expect(card).toHaveAttribute('data-maximized', 'true')
    await page.keyboard.press('Escape')
    await expect(card).not.toHaveAttribute('data-maximized', 'true')
    await expect(page.getByRole('button', { name: 'Maximize console-1' })).toBeFocused()

    // dialogs, popovers and menus: opened with Enter, walked inside (the focus stays in while it is open), closed with Esc, which returns the focus
    const openers: [string | RegExp, string][] = [
      [/"Project .*menu"/, '[role=menu]'],
      ['About', '[role=dialog]'],
      ['Spawn', '[role=dialog]'],
      ['Presets', '[role=dialog]'],
      ['Memory', '[role=dialog]'],
      ['Found a bug?', '[role=dialog]'],
    ]
    for (const [name, popup] of openers) {
      await tabTo(page, name)
      const opener = await focused(page)
      await page.keyboard.press('Enter')
      await expect(page.locator(popup).last()).toBeVisible()
      if (popup === '[role=menu]') {
        const items = await page.locator('[role=menu] [role^=menuitem]').count()
        const keys = new Set<string>()
        for (let i = 0; i < items; i++) {
          const f = await focused(page)
          expect(f.ring, `focus is visible on ${f.label}`).toBeGreaterThan(0)
          keys.add(f.key)
          await page.keyboard.press('ArrowDown')
        }
        expect(keys.size).toBe(items)
      } else if (await page.locator(`${popup}[aria-modal=true]`).count()) {
        const inside = await tabbable(page, `${popup}[aria-modal=true]`)
        const stops = await cycle(page, 'Tab')
        const got = new Set(stops.map((s) => s.label))
        expect(inside.filter((l) => !got.has(l)), `controls of ${String(name)} Tab never reached`).toEqual([])
        expect(await page.evaluate(() => !!document.activeElement?.closest('[aria-modal=true]')), 'the focus stays in the open dialog').toBe(true)
      }
      await page.keyboard.press('Escape')
      await expect(page.locator(popup)).toHaveCount(0)
      expect((await focused(page)).key, `Esc returns the focus to ${opener.label}`).toBe(opener.key)
    }
    expect(errors).toEqual([])
  } finally {
    await app.close()
    void tmp
  }
})

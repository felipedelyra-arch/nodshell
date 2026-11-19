import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Launched = { app: ElectronApplication; page: Page; tmp: string; errors: string[] }

const created: string[] = []

/** A temp dir owned by the current test; removed by cleanupTemp() (register it with test.afterEach). */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const tmp = tempDir('nodshell-e2e-')
  const app = await electron.launch({
    args: ['.'],
    // closing live processes is confirmed unless a test scripts the answer
    env: { ...process.env, HOME: tmp, NODSHELL_USER_DATA: join(tmp, 'userdata'), NODSHELL_TEST_CLOSE: 'yes', NODSHELL_TEST_LEAVE: 'yes', NODSHELL_TEST_DOM: '1', NODSHELL_TEST_AVAIL_MB: '65536', ...extraEnv }, // DOM renderer: the tests read the terminal text from the page
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
  await page.waitForSelector('button:has-text("New console")')
  // CSP violations raised after load (the ones at load are also logged as console errors)
  await page.evaluate(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  return { app, page, tmp, errors }
}

export async function newConsole(page: Page, count: number): Promise<void> {
  await page.getByRole('button', { name: 'New console' }).click()
  await expect(page.getByTestId('terminal-node')).toHaveCount(count)
}

/**
 * Types into a card's terminal. Below zoom ~0.82 an unselected card shows a summary and its terminal is hidden: the card is then opened in focus mode
 * (double-click on the summary), typed into, and restored.
 */
export async function typeInCard(page: Page, card: Locator, text: string): Promise<void> {
  const body = card.getByTestId('terminal-body')
  const summary = !(await body.isVisible())
  if (summary) await card.getByTestId('terminal-preview').dblclick()
  await body.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  if (summary) {
    await page.keyboard.press('Control+Shift+F')
    await expect(card).not.toHaveAttribute('data-maximized', 'true')
  }
}

export const typeIn = (page: Page, index: number, text: string): Promise<void> =>
  typeInCard(page, page.getByTestId('terminal-body').nth(index).locator('xpath=ancestor::*[contains(@class,"term-card")]'), text)

/** What a card shows of its output: the terminal when it is on screen, else the summary. */
export const screenOf = (card: Locator): Locator => card.locator('[data-testid=terminal-body]:visible, [data-testid=terminal-preview]')

export async function readFile(path: string): Promise<string> {
  let out = ''
  await expect.poll(() => { try { out = readFileSync(path, 'utf8').trim() } catch { out = '' } return out }, { timeout: 10_000 }).not.toBe('')
  return out
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Wheel over a bare spot of the board until the zoom passes `min`: cards show their terminals again (below ~0.82 they show a summary). */
export async function zoomInPast(page: Page, min = 0.9): Promise<void> {
  const zoom = () => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
  const spot = await page.evaluate(() => {
    for (let y = 120; y < innerHeight - 160; y += 20) for (let x = 90; x < innerWidth - 20; x += 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
    return null
  })
  await page.mouse.move(spot!.x, spot!.y)
  await expect.poll(async () => { await page.mouse.wheel(0, -200); return (await zoom()) > min }, { timeout: 30_000 }).toBe(true)
}

export async function expectGone(...pids: number[]): Promise<void> {
  for (const pid of pids) await expect.poll(() => alive(pid), { timeout: 10_000, message: `pid ${pid} still alive` }).toBe(false)
}

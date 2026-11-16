import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
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

export async function typeIn(page: Page, index: number, text: string): Promise<void> {
  await page.getByTestId('terminal-body').nth(index).click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

export async function readFile(path: string): Promise<string> {
  let out = ''
  await expect.poll(() => { try { out = readFileSync(path, 'utf8').trim() } catch { out = '' } return out }, { timeout: 10_000 }).not.toBe('')
  return out
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function expectGone(...pids: number[]): Promise<void> {
  for (const pid of pids) await expect.poll(() => alive(pid), { timeout: 10_000, message: `pid ${pid} still alive` }).toBe(false)
}

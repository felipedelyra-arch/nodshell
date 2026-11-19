// Opt-in (NODSHELL_REAL_AGENT=1): launches up to 3 REAL `claude` agents (owner's HOME, login and plugins) and measures their memory.
// Sends no prompt: the only keys typed into an agent are the answer "yes, trust" to the folder-trust dialog of the temp repo.
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openRepo, spawnPreset } from '../e2e/repo'
import { emptySpot, OUT, procs, ptyLeaders, ROOT, sleep } from './support'

test.skip(process.env['NODSHELL_REAL_AGENT'] !== '1', 'opt-in: starts real Claude Code agents')

const GiB = 2 ** 30
const memAvail = () => Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))![1]) * 1024
const mb = (kb: number) => Math.round(kb / 1024)
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!

class Abort extends Error {}
let closeAll: () => Promise<void> = async () => undefined
/** Sleeps in slices; below 2 GiB available everything is closed at once. */
async function wait(ms: number) {
  for (let t = 0; t < ms; t += 2000) {
    if (memAvail() < 2 * GiB) { await closeAll(); throw new Abort(`MemAvailable fell below 2 GiB (${(memAvail() / GiB).toFixed(2)})`) }
    await sleep(Math.min(2000, ms - t))
  }
}

const argvName = (pid: number) => {
  try {
    const a = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const parts = [basename(a[0] ?? '?')]
    if (a[1] && !a[1].startsWith('-')) parts.push(basename(a[1]))
    return parts.join(' ').slice(0, 40)
  } catch { return '?' }
}
const tree = (leader: number) => procs().filter((p) => p.sid === leader)
const treeMb = (leader: number) => mb(tree(leader).reduce((n, p) => n + p.rssKb, 0))
const claudeMb = (leader: number) => mb(tree(leader).filter((p) => p.comm === 'claude' || argvName(p.pid).startsWith('claude')).reduce((n, p) => n + p.rssKb, 0))
function children(leader: number) {
  const g: Record<string, number> = {}
  for (const p of tree(leader)) { const k = argvName(p.pid); g[k] = (g[k] ?? 0) + p.rssKb }
  return Object.entries(g).map(([name, kb]) => ({ name, mb: mb(kb) })).sort((a, b) => b.mb - a.mb)
}

const text = (card: Locator) => card.getByTestId('terminal-body').innerText().catch(() => '')
const lastLines = (t: string, n = 30) => t.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n')

/** Answers the folder-trust dialog of the temp repo, nothing else: any other question aborts. Returns what it saw and pressed. */
async function bringUp(page: Page, card: Locator, handled: { trust?: { screen: string; pressed: string } }, dir: string) {
  const t0 = Date.now()
  await card.getByRole('button', { name: /^Maximize / }).click()
  await expect(card).toHaveAttribute('data-maximized', 'true')
  for (;;) {
    await wait(2000)
    if ((await card.getByTestId('status-word').innerText()).trim() === 'resting') break
    if (Date.now() - t0 > 180_000) throw new Abort(`never reached resting:\n${lastLines(await text(card))}`)
    const t = await text(card)
    const trust = /trust/i.test(t) && /(yes|proceed)/i.test(t)
    const other = /(log ?in|sign ?in|authenticate|api key|update available|install|approve|mcp server|choose the text style|theme|select login|press enter to continue)/i.test(t)
    if (trust && !handled.trust && !other) {
      // options are unnumbered ("No, exit" is the default): move the cursor to the "yes, trust" line, check it is there, then confirm
      const sel = () => text(card).then((x) => x.split('\n').find((l) => /^\s*[❯>›]/.test(l))?.trim() ?? '')
      if (!/trust/i.test(t) || !t.replace(/\s/g, '').includes(dir.split('/').slice(-2, -1)[0]!.slice(0, 14)) || !/^\W*yes\b.*trust/im.test(t)) throw new Abort(`trust dialog not understood:\n${lastLines(t)}`)
      await card.getByTestId('terminal-body').click()
      const keys: string[] = []
      for (let i = 0; i < 2 && !/^\W*yes\b/i.test(await sel()); i++) { await page.keyboard.press('ArrowDown'); keys.push('ArrowDown'); await sleep(400) }
      const at = await sel()
      if (!/^\W*yes\b.*trust/i.test(at)) throw new Abort(`cursor not on the trust option (on "${at}")`)
      await page.keyboard.press('Enter'); keys.push('Enter')
      handled.trust = { screen: lastLines(t, 14), pressed: `${keys.join(', ')} (confirmed on "${at}")` }
      await wait(1500)
      continue
    }
    if (other || (/\?\s*$/m.test(t) && !trust && /(1\.|❯)/.test(t))) throw new Abort(`unexpected prompt, not answered:\n${lastLines(t)}`)
  }
  return Date.now() - t0
}

test('real agents: memory per agent', async () => {
  test.setTimeout(20 * 60_000)
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'nodshell-real-')))
  const repo = join(work, 'demo-real-agent')
  mkdirSync(repo)
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd: repo })
  git('init', '-q'); writeFileSync(join(repo, 'README.md'), '# demo\n'); git('add', '.'); git('commit', '-q', '-m', 'init')
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()
  const which = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
  expect(which).not.toContain('nodshell-e2e')

  const env: Record<string, string> = { ...(process.env as Record<string, string>), NODSHELL_USER_DATA: join(work, 'userdata'), NODSHELL_TEST_REPO: repo, NODSHELL_TEST_CLOSE: 'yes', NODSHELL_TEST_LEAVE: 'yes', NODSHELL_TEST_DOM: '1' }
  delete env['NODSHELL_TEST_AVAIL_MB']
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900))
  await page.waitForSelector('button:has-text("New console")')
  const mainPid = app.process().pid!
  const seen = new Set<number>()
  const out: Record<string, unknown> = { claudeVersion: version, claudePath: which, display: 'Xephyr :85 (software rendering)' }
  const handled: { trust?: { screen: string; pressed: string } } = {}
  closeAll = async () => { try { await page.getByRole('button', { name: 'Close all', exact: true }).click({ timeout: 5000 }) } catch { /* app gone */ } }
  const wall0 = { t: 0 }

  const usage = async () => {
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    const dlg = page.getByRole('dialog', { name: 'Memory' })
    await dlg.getByRole('tab', { name: 'Usage' }).click()
    await expect(dlg.getByTestId('usage-total')).toBeVisible({ timeout: 15_000 })
    await sleep(6000) // a fresh 5 s report
    const row = (l: Locator) => l.locator('td').allInnerTexts()
    const rows: unknown[] = []
    for (const r of await dlg.getByTestId('usage-row').all()) rows.push({ name: await r.locator('th').innerText(), cols: await row(r) })
    const res = { system: await dlg.getByTestId('memory-system').innerText(), rows, app: (await row(dlg.getByTestId('usage-app'))).join(' ').trim(), total: (await row(dlg.getByTestId('usage-total'))).join(' ').trim() }
    await page.keyboard.press('Escape')
    return res
  }

  const measure = async (agents: { leader: number; name: string }[], settle: number, gap: number) => {
    await wait(settle)
    const runs: { trees: number[]; claude: number[]; kids: { name: string; mb: number }[][]; avail: number }[] = []
    for (let i = 0; i < 3; i++) {
      if (i) await wait(gap)
      runs.push({ trees: agents.map((a) => treeMb(a.leader)), claude: agents.map((a) => claudeMb(a.leader)), kids: agents.map((a) => children(a.leader)), avail: memAvail() })
    }
    const perAgent = agents.map((a, i) => ({
      name: a.name,
      treeMb: median(runs.map((r) => r.trees[i]!)),
      claudeMb: median(runs.map((r) => r.claude[i]!)),
      children: (() => { const names = new Set(runs.flatMap((r) => r.kids[i]!.map((k) => k.name))); return [...names].map((n) => ({ name: n, mb: median(runs.map((r) => r.kids[i]!.find((k) => k.name === n)?.mb ?? 0)) })).sort((x, y) => y.mb - x.mb) })(),
    }))
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ type: x.type, pid: x.pid, mb: Math.round(x.memory.workingSetSize / 1024) })))
    return { perAgent, treeTotalMb: perAgent.reduce((n, a) => n + a.treeMb, 0), availAfterGiB: +(memAvail() / GiB).toFixed(2), nodshellProcs: metrics, usage: await usage() }
  }

  const agents: { leader: number; name: string }[] = []
  const stages: Record<string, unknown> = {}
  try {
    await openRepo(page)
    for (let n = 1; n <= 3; n++) {
      const before = memAvail()
      if (before < 4 * GiB) { out['stoppedAddingAt'] = `${n - 1} agents: MemAvailable ${(before / GiB).toFixed(2)} GiB < 4 GiB`; break }
      if (wall0.t && Date.now() - wall0.t > 8 * 60_000) { out['stoppedAddingAt'] = `${n - 1} agents: time budget`; break }
      await spawnPreset(page, 'Backend', 1)
      if (!wall0.t) wall0.t = Date.now()
      await expect(page.getByTestId('agent-node')).toHaveCount(n)
      const leader = ptyLeaders(mainPid).map((p) => p.pid).find((p) => !seen.has(p))!
      seen.add(leader)
      const card = page.getByTestId('agent-node').nth(n - 1)
      const name = (await card.locator('.name-text, .name-btn').first().innerText()).trim()
      agents.push({ leader, name })
      const ms = await bringUp(page, card, handled, repo)
      await page.keyboard.press('Control+Shift+F') // app shortcut, not sent to the agent
      await expect(card).not.toHaveAttribute('data-maximized', 'true')
      await expect(card.getByTestId('status-word')).toHaveText(/resting/, { timeout: 60_000 })
      const st: Record<string, unknown> = { spawnToRestingS: Math.round(ms / 1000), availBeforeGiB: +(before / GiB).toFixed(2) }
      if (n === 1) {
        Object.assign(st, await measure(agents, 60_000, 20_000))
        // extras: canvas FPS and typing in a plain console, with 1 agent resting
        out['extras'] = await extras(page)
      } else {
        Object.assign(st, await measure(agents, 30_000, 10_000))
        const per = Math.max(1.2 * GiB, (st['treeTotalMb'] as number) / n * 2 ** 20)
        st['roomByAppFormula'] = Math.floor((memAvail() - GiB) / per)
      }
      stages[`${n}agents`] = st
    }
  } catch (e) {
    out['aborted'] = String(e instanceof Error ? e.message : e)
  } finally {
    out['trustDialog'] = handled.trust ?? null
    out['wallSecondsWithAgents'] = wall0.t ? Math.round((Date.now() - wall0.t) / 1000) : 0
    out['stages'] = stages
    await closeAll()
    await sleep(6000)
    await app.close().catch(() => undefined)
    await sleep(2000)
    const survivors = procs().filter((p) => seen.has(p.sid))
    out['survivors'] = survivors.map((p) => `${p.pid}:${argvName(p.pid)}`)
    for (const p of survivors) try { process.kill(-p.sid, 'SIGKILL') } catch { /* gone */ }
    rmSync(work, { recursive: true, force: true })
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'real-agent.json'), JSON.stringify(out, null, 1))
    console.log(JSON.stringify(out, null, 1))
  }
})

async function extras(page: Page) {
  const fps = async (kind: 'pan' | 'zoom') => {
    const s = await emptySpot(page)
    if (!s) return null
    await page.mouse.move(s.x, s.y)
    await page.evaluate(() => { const w = window as unknown as { __f: number[] }; w.__f = []; const l = (t: number) => { if (w.__f) w.__f.push(t); requestAnimationFrame(l) }; requestAnimationFrame(l) })
    if (kind === 'pan') await page.mouse.down()
    const t0 = Date.now()
    for (let i = 0; Date.now() - t0 < 3000; i++) {
      if (kind === 'pan') await page.mouse.move(s.x + Math.sin(i / 12) * 220, s.y + Math.cos(i / 17) * 90)
      else await page.mouse.wheel(0, Math.floor(i / 14) % 2 === 0 ? -40 : 40)
      await sleep(7)
    }
    if (kind === 'pan') await page.mouse.up()
    return page.evaluate(() => { const w = window as unknown as { __f: number[] | null }; const t = w.__f!; w.__f = null; return Math.round(((t.length - 1) / ((t[t.length - 1]! - t[0]!) / 1000)) * 10) / 10 })
  }
  const r: Record<string, unknown> = { panFps: await fps('pan'), zoomFps: await fps('zoom') }
  await page.getByRole('button', { name: 'New console' }).click()
  const con = page.getByTestId('terminal-node')
  await expect(con).toHaveCount(1)
  await con.getByTestId('terminal-body').click({ force: true })
  await page.evaluate(() => {
    const w = window as unknown as { __lat: { down: number; out: number[] } }
    w.__lat = { down: 0, out: [] }
    window.addEventListener('keydown', () => (w.__lat.down = performance.now()), true)
    window.api.on('pty:data', () => { if (!w.__lat.down) return; const d = w.__lat.down; w.__lat.down = 0; requestAnimationFrame(() => w.__lat.out.push(performance.now() - d)) })
  })
  for (const ch of 'abcdefghijklmnopqrstuvwxyzabcd') { await page.keyboard.press(ch); await sleep(120) }
  const l = await page.evaluate(() => (window as unknown as { __lat: { out: number[] } }).__lat.out.sort((a, b) => a - b))
  r['typingMs'] = l.length ? { n: l.length, median: Math.round(l[Math.floor(l.length / 2)]!), p95: Math.round(l[Math.floor(l.length * 0.95)]!) } : { n: 0 }
  for (let i = 0; i < 30; i++) await page.keyboard.press('Backspace')
  await page.getByRole('button', { name: /^Close console-/ }).first().click()
  await expect(con).toHaveCount(0)
  return r
}

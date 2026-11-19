// Shared helpers of the perf harness (baseline.spec.ts, leak.spec.ts).
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDir } from '../e2e/helpers'

export const ROOT = resolve(__dirname, '../..')
export const OUT = process.env['NODSHELL_PERF_OUT'] ?? join(ROOT, 'tests/perf/out')

/** Merge into results.json by scenario key and print one line per metric. */
export const save = (k: string, v: unknown) => {
  mkdirSync(OUT, { recursive: true })
  let all: Record<string, unknown> = {}
  try { all = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')) } catch { /* first */ }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ ...all, [k]: v }, null, 1))
  const walk = (p: string, x: unknown) => {
    if (x !== null && typeof x === 'object') for (const [kk, vv] of Object.entries(x)) walk(`${p}.${kk}`, vv)
    else console.log(`${p} = ${JSON.stringify(x)}`)
  }
  walk(k, v)
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function launch(extra: Record<string, string> = {}, args: string[] = []) {
  const tmp = tempDir('nodshell-measure-')
  const app = await electron.launch({ args: ['.', ...args], cwd: ROOT, env: { ...process.env, HOME: tmp, NODSHELL_USER_DATA: join(tmp, 'userdata'), NODSHELL_TEST_CLOSE: 'yes', NODSHELL_TEST_LEAVE: 'yes', NODSHELL_TEST_AVAIL_MB: '65536', ...extra } })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900))
  await page.waitForSelector('button:has-text("New console")')
  await page.evaluate(() => {
    const w = window as unknown as { __f: { t: number[]; on: boolean } }
    w.__f = { t: [], on: false }
    const loop = (t: number) => { if (w.__f.on) w.__f.t.push(t); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
  return { app, page }
}

export const CLK_TCK = 100 // Linux USER_HZ
export type Stat = { pid: number; comm: string; ppid: number; sid: number; ticks: number; rssKb: number }
export function procs(): Stat[] {
  const out: Stat[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const s = readFileSync(`/proc/${name}/stat`, 'utf8')
      const comm = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'))
      const r = s.slice(s.lastIndexOf(')') + 2).split(' ')
      out.push({ pid: Number(name), comm, ppid: Number(r[1]), sid: Number(r[3]), ticks: Number(r[11]) + Number(r[12]), rssKb: Number(r[21]) * 4 })
    } catch { /* gone */ }
  }
  return out
}
/** PTY session leaders: direct children of the Electron main process that are not Electron itself. */
export const ptyLeaders = (mainPid: number) => procs().filter((p) => p.ppid === mainPid && p.sid === p.pid)

/** CPU % (of one core, from /proc ticks) and RSS per Electron process type, plus the PTY trees, averaged over `ms`. */
export async function sample(app: ElectronApplication, ms: number) {
  const mainPid = app.process().pid!
  const leaders = ptyLeaders(mainPid).map((p) => p.pid)
  const inPty = () => procs().filter((p) => leaders.includes(p.sid))
  const info = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ pid: x.pid, type: x.type, name: x.name ?? '' })))
  const tickMap = () => new Map(procs().map((p) => [p.pid, p.ticks]))
  const a = inPty()
  const ta = tickMap()
  const t0 = Date.now()
  await sleep(ms)
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ pid: x.pid, mb: Math.round(x.memory.workingSetSize / 1024) })))
  const secs = (Date.now() - t0) / 1000
  const tb = tickMap()
  const b = inPty()
  const ticks = (l: Stat[]) => l.reduce((n, p) => n + p.ticks, 0)
  const pct = (d: number) => Math.round((d / CLK_TCK / secs) * 1000) / 10
  const by: Record<string, { cpu: number; mb: number; n: number }> = {}
  let appCpu = 0
  let appMb = 0
  for (const x of info) {
    const k = x.type === 'Utility' ? `Utility:${x.name}` : x.type
    const e = (by[k] ??= { cpu: 0, mb: 0, n: 0 })
    const cpu = pct((tb.get(x.pid) ?? 0) - (ta.get(x.pid) ?? 0))
    const mb = m.find((y) => y.pid === x.pid)?.mb ?? 0
    e.cpu = Math.round((e.cpu + cpu) * 10) / 10; e.mb += mb; e.n++
    appCpu += cpu; appMb += mb
  }
  const ptyMb = Math.round(b.reduce((n, p) => n + p.rssKb, 0) / 1024)
  return { by, appMb, appCpu: Math.round(appCpu * 10) / 10, pty: { leaders: leaders.length, procs: b.length, mb: ptyMb, cpu: pct(ticks(b) - ticks(a)) } }
}

export const emptySpot = (page: Page) =>
  page.evaluate(() => {
    for (let y = 80; y < innerHeight - 170; y += 10) for (let x = 90; x < innerWidth - 20; x += 10) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
    return null
  })

export const writeAll = (page: Page, data: string) => page.evaluate(async (data) => { for (const n of document.querySelectorAll<HTMLElement>('.react-flow__node-terminal')) await window.api.invoke('pty:write', { id: n.dataset['id']!, data }) }, data)

// a TUI-like redraw (8 coloured lines repainted in place ~12 times a second), what an agent "thinking" does to a terminal
export const TUI = `while :; do printf '\\033[H'; for i in 1 2 3 4 5 6 7 8; do printf '\\033[3%dm● step %d  %s %s tokens\\033[0m\\033[K\\n' $((RANDOM%6+1)) $i $RANDOM $RANDOM; done; sleep 0.08; done\r`

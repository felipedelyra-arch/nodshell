import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { eventNames } from '../../src/shared/ipc/names'
import { cleanupTemp, launch, zoomInPast } from './helpers'
import { END, openRepo, setupRepo, START, submissions } from './repo'

test.afterEach(cleanupTemp)

const card = (page: Page, name: string) => page.locator(`[data-testid=agent-node][data-name="${name}"]`)
const procState = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  } catch {
    return 'gone'
  }
}

// Final acceptance (F10) on a full squad: a Frontend -> Reviewers flow fires by itself on Stop, Pause all holds it, and the renderer
// never sees a secret or a path. Closing and reopening the whole board is covered by persistence.test.ts ("acceptance: quit and reopen ...").
test('acceptance: Frontend -> Reviewers fires on Stop, Pause all holds everything until Resume all, and the renderer sees no path or secret', async () => {
  test.setTimeout(240_000)
  const r = setupRepo()
  const { app, page, tmp, errors } = await launch(r.env)
  try {
    // every main -> renderer event of the run is kept (pty:data is terminal output, not a DTO)
    await page.evaluate((names) => {
      const w = window as unknown as { __events: string[] }
      w.__events = []
      for (const n of names) if (n !== 'pty:data') window.api.on(n, (p) => w.__events.push(JSON.stringify(p)))
    }, [...eventNames])

    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Squad/ }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(9)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 60_000 })
    await expect(page.getByTestId('group-node')).toHaveCount(4)
    const pids = r.runs().map((x) => x.pid)
    const reviewers = r.runs().filter((x) => /reviewer-\d$/.test(x.cwd))
    expect(reviewers).toHaveLength(2)

    // an edge of our own: one Frontend agent -> the REVIEWERS group
    const [front] = await page.locator('[data-testid=agent-node]').evaluateAll((els) => els.filter((e) => e.querySelector('[data-testid=role-tag]')?.textContent === 'frontend').map((e) => e.getAttribute('data-name')!))
    await card(page, front!).getByRole('button', { name: front!, exact: true }).click()
    const details = page.getByRole('dialog', { name: `Details for ${front}` })
    await details.getByLabel('Connect to…').selectOption({ label: 'REVIEWERS group' })
    await details.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.locator('.react-flow__edge-flow')).toHaveCount(5)
    await card(page, front!).getByRole('button', { name: front!, exact: true }).click() // the name toggles the popover (Esc needs the focus inside it)
    await expect(details).toHaveCount(0)

    // a slow turn; Pause all in the middle of it freezes every process and the flow with it
    await zoomInPast(page) // a fitted squad shows summaries; typing needs the terminal
    await card(page, front!).getByTestId('terminal-body').click()
    await page.keyboard.type('SLOW REPLY:ship it')
    await page.keyboard.press('Enter')
    await expect(card(page, front!)).toHaveAttribute('data-state', 'working', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Pause all', exact: true }).click()
    await expect(card(page, front!).getByTestId('status-word')).toHaveText('paused')
    await expect.poll(() => pids.map(procState)).toEqual(pids.map(() => 'T'))
    await page.waitForTimeout(6000) // longer than the rest of the turn would take
    for (const x of reviewers) expect(submissions(r.logs, x.pid)).toEqual([])
    await expect(card(page, front!)).not.toHaveAttribute('data-state', 'idle')

    // Resume all: the turn ends, its Stop fires the edge, and both reviewers get the one message
    await page.getByRole('button', { name: 'Resume all', exact: true }).click()
    for (const x of reviewers) await expect.poll(() => submissions(r.logs, x.pid), { timeout: 30_000 }).toEqual([`${START}From ${front} (frontend):\nship it${END}`])
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(9, { timeout: 30_000 })

    // the renderer: no Node, only the two named bridge functions, and nothing it was sent holds a path or a token
    expect(await page.evaluate(() => [typeof require, typeof process, typeof Buffer, Object.keys(window.api).sort().join()])).toEqual(['undefined', 'undefined', 'undefined', 'invoke,on'])
    const events = await page.evaluate(() => (window as unknown as { __events: string[] }).__events)
    expect(events.length).toBeGreaterThan(10)

    // the answers of the bridge: wrapped here (window.api itself is frozen), every reply of the read-only channels is kept as text
    const ids = await page.locator('[data-testid=agent-node]').evaluateAll((els) => els.map((el) => el.closest('.react-flow__node')!.getAttribute('data-id')!))
    expect(ids).toHaveLength(9)
    const replies = await page.evaluate(async (ids) => {
      const out: string[] = []
      const call = async (c: string, p: unknown) => out.push(JSON.stringify(await (window.api.invoke as (c: string, p: unknown) => Promise<unknown>)(c, p).catch((e: Error) => e.message)))
      for (const c of ['app:diagnostics', 'preset:list', 'loop:list', 'voice:status', 'settings:get']) await call(c, undefined)
      for (const scope of ['global', 'repo']) await call('memory:get', { scope })
      for (const id of ids) await call('agent:lastMessage', { id })
      return out
    }, ids)
    expect(replies).toHaveLength(5 + 2 + 9)

    // the real secrets: each agent's MCP token and sockets, read from the config files its CLI was launched with
    const secrets = new Set<string>()
    for (const run of r.runs()) {
      for (const flag of ['--mcp-config=', '--settings=']) {
        const file = run.argv.find((a) => a.startsWith(flag))?.slice(flag.length)
        expect(file, `${flag} in the argv`).toBeTruthy()
        secrets.add(file!)
        const text = readFileSync(file!, 'utf8')
        for (const t of text.match(/[0-9a-f]{64}/g) ?? []) secrets.add(t)
        for (const m of text.matchAll(/"NODSHELL_\w*SOCKET":\s*"([^"]+)"/g)) secrets.add(m[1]!)
      }
      secrets.add(run.hookSocket)
      secrets.add(run.cwd)
    }
    expect([...secrets].filter((x) => /^[0-9a-f]{64}$/.test(x)).length).toBeGreaterThanOrEqual(9) // not vacuous: one token per agent
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    for (const text of [...events, ...replies, html]) {
      for (const secret of [...secrets, r.repo, tmp]) expect(text.includes(secret), `leaked ${secret.slice(0, 12)}...`).toBe(false)
      expect(text).not.toMatch(/\/(?:home|tmp|root|Users)\//)
    }
    for (const text of [...events, ...replies]) expect(text).not.toMatch(/worktrees|\.sock|\.claude|token/i)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

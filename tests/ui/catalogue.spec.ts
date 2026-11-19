// Screenshot catalogue of every UI component and state (npm run ui:shots). A capture tool: it asserts nothing about looks.
// Output: NODSHELL_UI_SHOTS (default tests/ui/out) / <NODSHELL_UI_PREFIX>-<component>-<state>.png, plus <prefix>-index.md and <prefix>-hit-targets.json.
import { createServer } from 'node:http'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { cleanupTemp, launch, newConsole, tempDir } from '../e2e/helpers'
import { openRepo, setupRepo, spawnPreset } from '../e2e/repo'
import { busyShot, HITS, measureHits, NOTES, OUT, park, PREFIX, shot, skip, states, step, note, focusVisible, blur } from './support'

test.afterEach(cleanupTemp)

async function boot(extra: Record<string, string> = {}) {
  const r = setupRepo()
  const l = await launch({ ...r.env, ...extra })
  l.page.setDefaultTimeout(8000)
  return { ...l, r }
}

const pills = (page: Page) => page.locator('button.pill')
const pill = (page: Page, i: number) => pills(page).nth(i)
const PILLS = ['new-console', 'spawn', 'group', 'presets', 'pause-all', 'resume-all', 'memory', 'close-all']
const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Board tools' }).getByRole('button', { name, exact: true })
/** Fit to content; a focus inside a card pans the board to the card, so everything stays in view while states are captured. */
async function fitView(page: Page): Promise<void> {
  await tool(page, 'Fit to content').click()
  await park(page)
  await page.waitForTimeout(700)
  const z = await page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
  if (z < 0.85) note('board-zoom', `fit zoom is ${z.toFixed(2)}: cards show their summary instead of a terminal`)
}
/** Escape, with the focus first moved inside the open dialog, popover or menu (the states helper blurs the control it captured). */
async function esc(page: Page): Promise<void> {
  const open = page.locator('[role=dialog], [role=alertdialog], [role=menu]').locator('visible=true')
  if (await open.count()) {
    const box = open.last()
    const inside = await box.evaluate((e) => e.contains(document.activeElement))
    if (!inside) await box.locator('button, input, select, textarea, [tabindex]').first().focus().catch(() => undefined)
  }
  await page.keyboard.press('Escape')
}
/** After a failed section: close whatever it left open. */
const reset = async (page: Page) => {
  for (let i = 0; i < 2; i++) await esc(page)
  await park(page)
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const agentCard = (page: Page) => page.getByTestId('agent-node').first()
const nameBtn = (card: Locator) => card.locator('.name-btn')

/** Bottom pills in whatever availability they have now (disabled ones are named so). */
async function pillStates(page: Page): Promise<void> {
  await step('pills-row', async () => {
    await park(page)
    await shot(page, `pills-row-${(await pill(page, 4).getAttribute('aria-disabled')) === 'true' ? 'idle' : 'live'}`, [pill(page, 0), pill(page, 7)])
  })
  for (const [i, n] of PILLS.entries()) await step(`pill-${n}`, () => states(page, `pill-${n}`, pill(page, i)))
}

async function toolbarStates(page: Page): Promise<void> {
  const bar = page.getByRole('toolbar', { name: 'Board tools' })
  await step('toolbar-whole', async () => {
    await park(page)
    await shot(page, 'toolbar-whole', bar)
  })
  for (const name of ['Select', 'Add agents', 'Shapes', 'Web tile', 'Text', 'Pen', 'Eraser', 'Color', 'Image', 'Fit to content']) {
    const b = tool(page, name)
    const id = `tool-${slug(name)}`
    await step(id, async () => {
      await states(page, id, b)
      const pressed = await b.getAttribute('aria-pressed')
      if (pressed === 'false') {
        await b.click()
        await park(page)
        await shot(page, `${id}-active`, b)
        await tool(page, 'Select').click()
      } else if (pressed === 'true') await shot(page, `${id}-active`, b)
    })
  }
  await step('color-menu', async () => {
    await tool(page, 'Color').click()
    await shot(page, 'color-menu-open', [tool(page, 'Color'), page.getByRole('dialog', { name: 'Annotation color' })])
    await esc(page)
  })
}

async function topBarStates(page: Page, withRepo: boolean): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  const items: [string, Locator][] = [
    ['back-to-home', nav.getByRole('button', { name: /Back to home/ })],
    ['project', nav.getByTestId('workspace')],
    ['workspace-tab', nav.getByRole('tab').first()],
    ['new-workspace', nav.getByRole('button', { name: 'New workspace' })],
    ['close-workspace', nav.getByRole('button', { name: 'Close workspace' })],
    ['info', page.getByRole('button', { name: 'About' })],
  ]
  const suffix = withRepo ? '-repo' : ''
  await step('topbar-live-chip', () => states(page, 'topbar-live-chip', page.getByTestId('live-badge'), [], ['normal', 'hover'])) // a status chip, not focusable
  for (const [n, l] of items) await step(`topbar-${n}`, () => states(page, `topbar-${n}${n === 'back-to-home' || n === 'project' || n === 'new-workspace' ? suffix : ''}`, l))
  await step('topbar-whole', async () => {
    await park(page)
    await shot(page, `topbar-whole${suffix}`, [nav, page.getByTestId('live-badge'), page.getByTestId('top-slot')], { x: 12, y: 12 })
  })
}

async function commandBarBasics(page: Page): Promise<void> {
  const bar = page.locator('.cmd-bar')
  const input = page.getByRole('combobox', { name: 'Command', exact: true })
  await step('cmdbar-empty', async () => {
    await park(page)
    await shot(page, 'cmdbar-empty', bar)
  })
  await step('cmdbar-input-focus', async () => {
    await input.focus()
    await shot(page, 'cmdbar-input-focus', bar)
  })
  for (const [n, label] of [['send', 'Send'], ['history', 'Show history'], ['mic', 'Dictate command']] as const) {
    await step(`cmdbar-${n}`, () => states(page, `cmdbar-${n}`, page.getByRole('button', { name: label })))
  }
  await step('cmdbar-text', async () => {
    await input.fill('review the checkout flow')
    await park(page)
    await shot(page, 'cmdbar-text', bar)
    await states(page, 'cmdbar-send', page.getByRole('button', { name: 'Send' }))
    await busyShot(page, 'cmdbar-send', page.getByRole('button', { name: 'Send' }))
  })
  await input.fill('')
  await blur(page)
}

// ---------------------------------------------------------------------------------------------------------------------

test('chrome without a project: toolbar, top bar, pills, command bar, footer', async () => {
  test.setTimeout(240_000)
  const { app, page } = await boot()
  try {
    await toolbarStates(page)
    await topBarStates(page, false)
    await pillStates(page)
    await commandBarBasics(page)
    await step('footer-bug', () => states(page, 'footer-bug', page.getByRole('button', { name: 'Found a bug?' })))
    await step('board-empty', async () => {
      await park(page)
      await shot(page, 'board-empty', page.locator('.react-flow'), 0)
    })
    await measureHits(page, 'no project')

    await openRepo(page)
    await topBarStates(page, true)
    await step('project-menu', async () => {
      const b = page.getByTestId('workspace')
      await shot(page, 'topbar-project-menu-closed', b)
      await b.click()
      const menu = page.getByRole('menu', { name: 'Project' })
      await shot(page, 'topbar-project-menu-open', [b, menu])
      await states(page, 'topbar-project-menuitem-open-folder', menu.getByRole('menuitem'), [], ['hover', 'focus'])
      await esc(page)
    })
    await step('footer-git', async () => {
      const chip = page.locator('p.footer-chip')
      await park(page)
      await shot(page, 'footer-git-normal', chip)
      await chip.hover()
      await shot(page, 'footer-git-hover', chip)
    })
    await measureHits(page, 'project open, empty board')
  } finally {
    await app.close()
  }
})

test('cards: console and agent, details, group popover, spawn, command bar with agents', async () => {
  test.setTimeout(280_000)
  const { app, page } = await boot()
  try {
    await openRepo(page)
    await newConsole(page, 1)
    await spawnPreset(page, 'Backend', 1)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(1, { timeout: 60_000 })
    await fitView(page)
    await step('board-cards', async () => {
      await park(page)
      await shot(page, 'board-cards', page.locator('.react-flow'), 0)
    })
    await pillStates(page)
    await busyShot(page, 'pill-close-all', pill(page, 7))
    await busyShot(page, 'pill-new-console', pill(page, 0))
    await toolbarStates(page)

    const agent = agentCard(page)
    const cons = page.getByTestId('terminal-node').first()
    const head = (c: Locator) => c.locator('.card-head')
    for (const [kind, card] of [['agent', agent], ['console', cons]] as const) {
      await step(`card-${kind}-header`, async () => {
        await park(page)
        await shot(page, `card-${kind}-header-normal`, head(card))
        await shot(page, `card-${kind}-whole`, card)
      })
    }
    await step('card-agent-name', () => states(page, 'card-agent-name', nameBtn(agent)))
    for (const [kind, card] of [['agent', agent], ['console', cons]] as const) {
      const btns = card.locator('.card-head button.icon-btn')
      const n = await btns.count()
      for (let i = 0; i < n; i++) {
        const label = (await btns.nth(i).getAttribute('aria-label')) ?? `button-${i}`
        const id = `card-${kind}-${slug(label.split(' ')[0] ?? label)}`
        await step(id, () => states(page, id, btns.nth(i)))
      }
    }
    // selected + resize handles
    await step('card-selected', async () => {
      await agent.locator('.status-pill').click()
      await park(page)
      await shot(page, 'card-agent-selected', agent)
      skip('card-agent-resize-handles', 'a grouped card has no resize handles; see card-console-resize-handles')
    })
    await step('card-console-selected', async () => {
      await cons.locator('.status-pill').click()
      await park(page)
      await shot(page, 'card-console-selected', cons)
      await shot(page, 'card-console-resize-handles', cons, 28)
      await cons.locator('.resize-handle').first().hover({ force: true, timeout: 3000 })
      await shot(page, 'card-console-resize-handle-hover', cons, 28)
    })
    // pinned (an agent in a group has its position set by the group: its pin is disabled, see card-agent-pin-*-disabled)
    await step('card-pinned', async () => {
      await cons.getByRole('button', { name: /^Pin / }).click()
      await park(page)
      await shot(page, 'card-console-pinned', head(cons))
      await shot(page, 'card-console-pinned-whole', cons)
      await states(page, 'card-console-unpin', cons.getByRole('button', { name: /^Unpin / }), [], ['hover', 'focus'])
      await cons.getByRole('button', { name: /^Unpin / }).click()
    })
    // details popover
    const name = (await agent.getAttribute('data-name'))!
    await step('details', async () => {
      await nameBtn(agent).click()
      const d = page.getByRole('dialog', { name: `Details for ${name}` })
      await park(page)
      await shot(page, 'card-agent-details-open', [agent, agent.getByRole('dialog')])
      await focusVisible(page, 'details-prompt-focus', d.getByLabel(`Prompt for ${name}`))
      await shot(page, 'card-agent-details-prompt-focus', [agent, agent.getByRole('dialog')])
      await blur(page)
      await measureHits(page, 'agent details popover')
      const loop = d.locator('.loop-box summary, .loop-box button').first()
      if (await loop.count()) {
        await loop.click()
        await shot(page, 'card-agent-details-loop-open', [agent, agent.getByRole('dialog')])
      } else skip('card-agent-details-loop-open', 'no loop control found')
      await esc(page)
    })
    // command bar with agents: suggestions, history
    await step('cmdbar-suggestions', async () => {
      const input = page.getByRole('combobox', { name: 'Command', exact: true })
      await input.fill('@')
      await shot(page, 'cmdbar-suggestions-open', [page.locator('.cmd-bar'), page.getByRole('listbox', { name: 'Agents and groups' })], { x: 12, y: 12 })
      await input.fill(`@${name} hello`)
      await input.press('Enter')
      await page.waitForTimeout(500)
    })
    await step('cmdbar-history', async () => {
      const h = page.getByRole('button', { name: 'Show history' })
      await h.click()
      await shot(page, 'cmdbar-history-open', [page.locator('.cmd-bar'), page.getByRole('menu', { name: 'Recent commands' })], { x: 12, y: 12 })
      await states(page, 'cmdbar-history-item', page.getByRole('menuitem').first(), [], ['hover', 'focus'])
      await esc(page)
    })
    // exited console
    await step('card-console-exited', async () => {
      await page.getByTestId('terminal-body').first().click()
      await page.keyboard.type('exit')
      await page.keyboard.press('Enter')
      await expect(cons).toHaveAttribute('data-status', 'exited')
      await park(page)
      await shot(page, 'card-console-exited', cons)
      await shot(page, 'card-console-exited-header', head(cons))
    })
    // paused (Pause all)
    await step('pause-all', async () => {
      await pill(page, 4).click()
      await expect(page.locator('[data-testid=agent-node][data-paused]').first()).toBeVisible()
      await park(page)
      await shot(page, 'card-agent-paused', agent)
      await states(page, 'pill-resume-all-after-pause', pill(page, 5))
      await states(page, 'pill-pause-all-after-pause', pill(page, 4))
      await pill(page, 5).click()
    })
    // spawn popover
    await step('dialog-spawn-popover', async () => {
      await pill(page, 1).click()
      const d = page.getByRole('dialog', { name: 'Spawn agents' })
      await shot(page, 'dialog-spawn-popover', [d, pill(page, 1)])
      await states(page, 'spawn-popover-more', d.getByRole('button', { name: 'More agents' }), [], ['hover', 'pressed', 'focus'])
      await states(page, 'spawn-popover-fewer', d.getByRole('button', { name: 'Fewer agents' }))
      await focusVisible(page, 'spawn-preset-focus', d.getByLabel('Preset'))
      await shot(page, 'dialog-spawn-popover-preset-focus', [d, pill(page, 1)])
      await measureHits(page, 'spawn popover')
      await esc(page)
    })
    // maximized
    await step('card-maximized', async () => {
      await agent.getByRole('button', { name: /^Maximize / }).click()
      await page.waitForTimeout(500)
      await park(page)
      await shot(page, 'card-agent-maximized', agent, 0)
      await shot(page, 'card-agent-maximized-header', head(agent))
      await measureHits(page, 'maximized card')
      await agent.getByRole('button', { name: /^Restore / }).click()
    })
    // summary state (zoomed out)
    await step('card-summary', async () => {
      const spot = await page.evaluate(() => ({ x: innerWidth - 40, y: 120 }))
      await page.mouse.move(spot.x, spot.y)
      const zoom = () => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
      await expect.poll(async () => (await page.mouse.wheel(0, 300), (await zoom()) < 0.45), { timeout: 30_000 }).toBe(true)
      await page.waitForTimeout(500)
      await park(page)
      await shot(page, 'card-agent-summary', agent)
      await shot(page, 'card-console-summary', cons)
      await shot(page, 'board-zoomed-out', page.locator('.react-flow'), 0)
    })
    await measureHits(page, 'cards board')
  } finally {
    await app.close()
  }
})

test('handoff dialog and Pause all on two agents', async () => {
  test.setTimeout(200_000)
  const { app, page } = await boot()
  try {
    await openRepo(page)
    await spawnPreset(page, 'Frontend', 2)
    await expect(page.locator('[data-testid=agent-node][data-state=idle]')).toHaveCount(2, { timeout: 60_000 })
    await fitView(page)
    // handoff dialog (a real one: the origin writes the briefing)
    await step('dialog-handoff', async () => {
      const names = await page.getByTestId('agent-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')!))
      const [a, b] = names as [string, string]
      await nameBtn(page.locator(`[data-testid=agent-node][data-name="${a}"]`)).click()
      const d = page.getByRole('dialog', { name: `Details for ${a}` })
      await d.getByLabel('Hand off to').selectOption({ label: b })
      await d.getByRole('button', { name: 'Hand off', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: `Hand off ${a} → ${b}` })
      await dlg.waitFor({ timeout: 20_000 })
      await park(page)
      await shot(page, 'dialog-handoff', dlg, 20)
      await measureHits(page, 'handoff dialog')
      await dlg.getByRole('button', { name: 'Cancel' }).click()
    })
    await measureHits(page, 'two agents board')
  } finally {
    await app.close()
  }
})

test('squad: groups, Orchestrator, edges and the edge editor', async () => {
  test.setTimeout(280_000)
  const { app, page } = await boot()
  try {
    await openRepo(page)
    await page.getByRole('button', { name: 'Presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Presets' }).getByRole('list', { name: 'Layouts' }).getByRole('button', { name: /^Small squad/ }).click()
    await expect(page.getByTestId('agent-node')).toHaveCount(5, { timeout: 60_000 })
    await expect(page.getByTestId('orchestrator-node')).toHaveCount(1)
    await page.waitForTimeout(3000)
    await park(page)
    await step('board-squad', () => shot(page, 'board-squad', page.locator('.react-flow'), 0))
    await measureHits(page, 'squad board')

    const group = page.getByTestId('group-node').first()
    const label = group.locator('.group-label')
    await step('group-label', async () => {
      await shot(page, 'group-label-normal', label)
      await shot(page, 'group-frame-normal', group, 24)
      await label.hover()
      await shot(page, 'group-label-hover', [label, group], 24)
    })
    for (const [n, loc] of [['collapse', group.getByRole('button', { name: /^Collapse / })], ['ungroup', group.locator('.ungroup-btn')], ['connect', group.locator('.connect-btn')]] as const) {
      await step(`group-${n}`, async () => {
        await label.hover()
        await states(page, `group-btn-${n}`, loc)
      })
    }
    await step('group-connect-menu', async () => {
      await group.locator('.connect-btn').click()
      const d = page.getByRole('dialog', { name: /^Connect / })
      await shot(page, 'group-connect-menu-open', [group, d], 24)
      await measureHits(page, 'group connect menu')
      await esc(page)
    })
    await step('group-collapsed', async () => {
      await group.getByRole('button', { name: /^Collapse / }).click()
      await park(page)
      await shot(page, 'group-collapsed', group, 24)
      await group.getByRole('button', { name: /^Expand / }).click()
    })

    const orch = page.getByTestId('orchestrator-node')
    await step('orch-whole', async () => {
      await park(page)
      await shot(page, 'orch-whole', orch)
      await orch.click({ position: { x: 20, y: 20 } })
      await park(page)
      await shot(page, 'orch-selected', orch)
    })
    await step('orch-connect', () => states(page, 'orch-connect', orch.locator('.orch-connect')))
    await busyShot(page, 'orch-connect', orch.locator('.orch-connect'))
    await step('orch-footer', async () => {
      const field = orch.locator('.orch-field input')
      await focusVisible(page, 'orch-field-focus', field)
      await shot(page, 'orch-footer-field-focus', orch.locator('.orch-foot'))
      await field.fill('@')
      await shot(page, 'orch-footer-field-at', orch.locator('.orch-foot'), { x: 12, y: 80 })
      await field.fill('')
      await blur(page)
      for (const label of ['Send command', /^Open Orchestrator terminal/, 'Close Orchestrator']) {
        const b = orch.getByRole('button', { name: label })
        await states(page, `orch-btn-${slug(typeof label === 'string' ? label : 'expand')}`, b, [], ['normal', 'hover', 'focus'])
      }
      await states(page, 'orch-dictate', orch.locator('.orch-foot .icon-btn').last(), [], ['normal', 'hover', 'focus'])
    })

    const dot = page.getByTestId('flow-edge-dot').first()
    const path = page.getByTestId('flow-edge').first()
    await step('edge-normal', async () => {
      await park(page)
      await shot(page, 'edge-normal', [path, dot], 24)
      await shot(page, 'edge-dot-normal', dot, 24)
      await states(page, 'edge-dot', dot, [], ['hover', 'pressed', 'focus'])
    })
    await step('edge-editor', async () => {
      await dot.click()
      const ed = page.getByTestId('edge-editor')
      await ed.waitFor()
      await park(page)
      await shot(page, 'edge-editor-open', [ed, dot], 20)
      await measureHits(page, 'edge editor')
      for (const [n, b] of [['remove', ed.getByRole('button', { name: 'Remove' })], ['pause', ed.getByRole('button', { name: 'Pause' })], ['save', ed.getByRole('button', { name: 'Save' })]] as const) {
        await step(`edge-editor-${n}`, () => states(page, `edge-editor-${n}`, b, [ed], ['normal', 'hover', 'focus']))
      }
      await step('edge-editor-remove-confirm', async () => {
        await ed.getByRole('button', { name: 'Remove' }).click()
        await park(page)
        await shot(page, 'edge-editor-remove-confirm', [ed, dot], 20)
        await ed.getByRole('button', { name: 'Keep' }).click()
      })
      await focusVisible(page, 'edge-editor-template-focus', ed.getByLabel('Template'))
      await shot(page, 'edge-editor-template-focus', [ed, dot], 20)
      await ed.getByLabel('Template').fill('Review this: {message}')
      await park(page)
      await shot(page, 'edge-editor-save-enabled', [ed, dot], 20)
      await states(page, 'edge-editor-save-enabled', ed.getByRole('button', { name: 'Save' }), [], ['hover', 'focus'])
      await ed.getByLabel('Template').fill('')
      await shot(page, 'edge-editor-invalid-template', [ed, dot], 20)
      await ed.getByRole('button', { name: 'Pause' }).click()
      await expect(ed.getByTestId('edge-status')).toContainText('Paused')
      await park(page)
      await shot(page, 'edge-editor-paused', [ed, dot], 20)
      await esc(page)
      await park(page)
      await shot(page, 'edge-paused', [path, dot], 24)
      await shot(page, 'edge-dot-paused', dot, 24)
    })
    await step('squad-pause-all', async () => {
      await dot.click()
      await page.getByTestId('edge-editor').getByRole('button', { name: 'Resume' }).click()
      await esc(page)
    })
  } finally {
    await app.close()
  }
})

test('dialogs: Presets, Memory, About, Found a bug, web tile popover', async () => {
  test.setTimeout(240_000)
  const { app, page } = await boot()
  try {
    await openRepo(page)
    const dstep = async (n: string, f: () => Promise<unknown>) => (await step(n, f), await reset(page))
    // group popover (two selected cards)
    await dstep('dialog-group-popover', async () => {
      await newConsole(page, 1)
      await newConsole(page, 2)
      await fitView(page)
      const heads = page.getByTestId('terminal-node').locator('.drag-handle')
      await heads.nth(0).click({ position: { x: 14, y: 8 } })
      await heads.nth(1).click({ position: { x: 14, y: 8 }, modifiers: ['Shift'] })
      await pill(page, 2).click()
      const d = page.getByRole('dialog', { name: 'New group' })
      await shot(page, 'dialog-group-popover', [d, pill(page, 2)])
      await focusVisible(page, 'group-popover-focus', d.getByLabel('Group name'))
      await shot(page, 'dialog-group-popover-field-focus', [d, pill(page, 2)])
      await d.getByLabel('Group name').fill('x'.repeat(60))
      await shot(page, 'dialog-group-popover-long-name', [d, pill(page, 2)])
      await d.getByLabel('Group name').fill('Checkout')
      await states(page, 'group-popover-create', d.getByRole('button', { name: 'Create group' }), [], ['hover', 'focus'])
      await measureHits(page, 'group popover')
      await esc(page)
    })
    await dstep('dialog-presets', async () => {
      await pill(page, 3).click()
      const d = page.getByRole('dialog', { name: 'Presets' })
      await d.waitFor()
      await park(page)
      await shot(page, 'dialog-presets-list', d, 20)
      await measureHits(page, 'presets dialog')
      const items = d.getByRole('list', { name: 'Preset list' }).getByRole('button')
      await states(page, 'presets-item', items.nth(1), [], ['hover', 'focus'])
      await items.nth(1).click()
      await shot(page, 'dialog-presets-selected', d, 20)
      await states(page, 'presets-layout-small-squad', d.getByRole('list', { name: 'Layouts' }).getByRole('button').first(), [], ['normal', 'hover', 'focus'])
      const form = d.locator('form')
      await focusVisible(page, 'presets-name-focus', form.locator('input.field').first())
      await shot(page, 'dialog-presets-field-focus', d, 20)
      await blur(page)
      // a custom preset, so Delete (danger) exists
      await d.getByRole('button', { name: '+ New preset' }).click()
      await form.locator('input.field').first().fill('Catalogue sample')
      await form.locator('input.field').nth(1).fill('sample')
      await form.getByRole('button', { name: 'Save' }).click()
      await expect(d.getByRole('button', { name: 'Catalogue sample' })).toBeVisible()
      await d.getByRole('button', { name: 'Catalogue sample' }).click()
      await states(page, 'presets-delete', form.getByRole('button', { name: 'Delete' }), [], ['hover', 'focus'])
      await form.getByRole('button', { name: 'Delete' }).click()
      await park(page)
      await shot(page, 'dialog-presets-delete-confirm', d, 20)
      await states(page, 'presets-confirm-delete', d.getByRole('alertdialog').getByRole('button', { name: 'Delete' }), [], ['hover', 'pressed', 'focus'])
      await d.getByRole('button', { name: 'Keep' }).click()
      await d.getByRole('button', { name: '+ New preset' }).click()
      await form.locator('input.field').first().fill('')
      await form.getByRole('button', { name: 'Save' }).click()
      await park(page)
      await shot(page, 'dialog-presets-name-error', d, 20)
      await states(page, 'presets-save', form.getByRole('button', { name: 'Save' }), [], ['normal', 'hover', 'pressed', 'focus'])
      await busyShot(page, 'presets-save', form.getByRole('button', { name: 'Save' }))
      await states(page, 'presets-close', d.getByRole('button', { name: 'Close', exact: true }), [], ['hover', 'focus'])
      await esc(page)
    })
    await dstep('dialog-memory', async () => {
      await pill(page, 6).click()
      const d = page.getByRole('dialog', { name: 'Memory' })
      await d.waitFor()
      await park(page)
      await shot(page, 'dialog-memory-notes', d, 20)
      await measureHits(page, 'memory dialog')
      const tabs = d.getByRole('tab')
      await states(page, 'memory-tab-second', tabs.nth(1), [], ['hover', 'focus'])
      await focusVisible(page, 'memory-text-focus', d.getByTestId('memory-text'))
      await d.getByTestId('memory-text').fill('# Notes\n- the checkout flow uses Stripe')
      await shot(page, 'dialog-memory-notes-edited', d, 20)
      await d.getByTestId('memory-text').fill('')
      await blur(page)
      await tabs.last().click()
      await page.waitForTimeout(1500)
      await park(page)
      await shot(page, 'dialog-memory-usage', d, 20)
    })
    await dstep('dialog-about', async () => {
      await page.getByRole('button', { name: 'About' }).click()
      const d = page.getByRole('dialog', { name: 'About' })
      await d.waitFor()
      await park(page)
      await shot(page, 'dialog-about', d, 20)
      await measureHits(page, 'about dialog')
      const field = d.getByLabel(/Live terminal limit/)
      await focusVisible(page, 'about-limit-focus', field)
      await shot(page, 'dialog-about-limit-focus', d, 20)
      await field.fill('99')
      await shot(page, 'dialog-about-limit-invalid', d, 20)
      await states(page, 'about-save', d.getByRole('button', { name: 'Save' }), [], ['normal', 'hover'])
      await field.fill('20')
      await states(page, 'about-save', d.getByRole('button', { name: 'Save' }), [], ['normal', 'hover', 'pressed', 'focus'])
      await esc(page)
    })
    await dstep('dialog-bug', async () => {
      await page.getByRole('button', { name: 'Found a bug?' }).click()
      const d = page.getByRole('dialog', { name: 'Found a bug?' })
      await expect(d.getByLabel('Diagnostic')).toContainText('Process limit')
      await park(page)
      await shot(page, 'dialog-bug', d, 20)
      await measureHits(page, 'bug dialog')
      await states(page, 'bug-copy', d.getByRole('button', { name: 'Copy' }), [], ['normal', 'hover', 'pressed', 'focus'])
      await d.getByRole('button', { name: 'Copy' }).click()
      await shot(page, 'dialog-bug-copied', d, 20)
      await esc(page)
    })
    await dstep('dialog-webtile-popover', async () => {
      await tool(page, 'Web tile').click()
      const d = page.getByRole('dialog', { name: 'New web tile' })
      await shot(page, 'dialog-webtile-popover', [d, tool(page, 'Web tile')], 20)
      await measureHits(page, 'web tile popover')
      await focusVisible(page, 'webtile-popover-focus', d.getByLabel('Address'))
      await shot(page, 'dialog-webtile-popover-field-focus', [d, tool(page, 'Web tile')], 20)
      await d.getByLabel('Address').fill('file:///etc/passwd')
      await d.getByRole('button', { name: 'Open' }).click()
      await shot(page, 'dialog-webtile-popover-invalid', [d, tool(page, 'Web tile')], 20)
      await d.getByLabel('Address').fill('')
      await shot(page, 'dialog-webtile-popover-open-disabled', [d, tool(page, 'Web tile')], 20)
      await esc(page)
    })
  } finally {
    await app.close()
  }
})

test('web tile: default, navigation, address, viewport menu, crashed page', async () => {
  test.setTimeout(200_000)
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><title>${req.url === '/other' ? 'Other page' : 'Preview One'}</title><body style="background:#16324f;color:#fff;font:28px sans-serif"><h1>catalogue</h1><a href="/other">other</a></body>`)
  })
  await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`
  const { app, page } = await boot()
  try {
    await tool(page, 'Web tile').click()
    const dlg = page.getByRole('dialog', { name: 'New web tile' })
    await dlg.getByLabel('Address').fill(url)
    await dlg.getByRole('button', { name: 'Open' }).click()
    const tile = page.getByTestId('web-tile')
    const title = page.getByTestId('tile-title')
    await expect(title).toHaveText('Preview One')
    await page.waitForTimeout(800)
    note('webtile-*', 'the page itself is a native view: page screenshots show the tile chrome only, the body area is empty')
    await step('webtile-default', async () => {
      await park(page)
      await shot(page, 'webtile-default', tile, 16)
      await tile.click({ position: { x: 20, y: 12 } })
      await park(page)
      await shot(page, 'webtile-selected', tile, 16)
    })
    for (const [n, name] of [['back', 'Back'], ['forward', 'Forward'], ['reload', 'Reload page'], ['focus-mode', 'Focus mode'], ['close', 'Close web tile']] as const) {
      await step(`webtile-${n}`, () => states(page, `webtile-btn-${n}`, tile.getByRole('button', { name }), [], n === 'close' ? ['normal', 'hover', 'focus'] : ['normal', 'hover', 'pressed', 'focus']))
    }
    await step('webtile-address', async () => {
      const field = tile.getByRole('textbox', { name: 'Address' })
      await focusVisible(page, 'webtile-address-focus', field)
      await shot(page, 'webtile-address-focus', tile.locator('.tile-nav'))
      await field.fill(url + 'other')
      await field.press('Enter')
      await expect(title).toHaveText('Other page')
      await blur(page)
      await park(page)
      await shot(page, 'webtile-nav-back-enabled', tile.locator('.tile-nav'))
      await states(page, 'webtile-btn-back-enabled', tile.getByRole('button', { name: 'Back' }), [], ['hover', 'focus'])
      await field.fill('file:///etc/passwd')
      await field.press('Enter')
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await shot(page, 'webtile-address-invalid', [tile.locator('.tile-nav'), page.getByRole('alert')], { x: 12, y: 20 })
      await field.press('Escape')
    })
    await step('webtile-viewport', async () => {
      const b = tile.locator('.tile-viewport')
      await states(page, 'webtile-viewport-btn', b)
      await b.click()
      const menu = page.getByRole('menu', { name: 'Viewport' })
      await shot(page, 'webtile-viewport-menu-open', [tile, menu], 12)
      await states(page, 'webtile-viewport-menuitem', menu.getByRole('menuitemradio').nth(1), [], ['hover', 'focus'])
      await esc(page)
    })
    await measureHits(page, 'web tile')
    await step('webtile-error', async () => {
      await app.evaluate(({ webContents, session }) => {
        const s = session.fromPartition('webtiles')
        webContents.getAllWebContents().find((w) => w.session === s && !w.isDestroyed())!.forcefullyCrashRenderer()
      })
      await expect(title).toContainText(/The page (crashed|was stopped by the system)/)
      await park(page)
      await shot(page, 'webtile-error', tile, 16)
    })
  } finally {
    await app.close()
    await new Promise<void>((done) => (srv.closeAllConnections(), srv.close(() => done())))
  }
})

test('toasts: info, error, with an action', async () => {
  test.setTimeout(120_000)
  const { app, page } = await boot()
  const toast = page.locator('p.pointer-events-auto')
  try {
    await openRepo(page)
    await step('toast-info', async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('loop:notice', { text: 'Loop on Zoe ended: the goal text appeared' }))
      await toast.waitFor()
      await shot(page, 'toast-info', toast, 20)
    })
    await step('toast-error', async () => {
      const input = page.getByRole('combobox', { name: 'Command', exact: true })
      await input.fill('hello there')
      await input.press('Enter')
      await expect(page.getByRole('alert')).toBeVisible()
      await shot(page, 'toast-error', page.getByRole('alert'), 20)
    })
    await step('toast-action', async () => {
      await expect(toast).toHaveCount(0, { timeout: 15_000 }) // a localhost offer never replaces a notice that is still showing
      await newConsole(page, 1)
      await page.getByTestId('terminal-body').first().click()
      await page.keyboard.type('echo http://localhost:3000')
      await page.keyboard.press('Enter')
      const open = page.getByRole('button', { name: 'Open as web tile' })
      await open.waitFor({ timeout: 15_000 })
      await park(page)
      await shot(page, 'toast-action', toast, 20)
      await states(page, 'toast-action-button', open, [toast], ['hover', 'pressed', 'focus'])
      await measureHits(page, 'toast with action')
    })
  } finally {
    await app.close()
  }
})

test('restore dialog: Choose terminals', async () => {
  test.setTimeout(200_000)
  const r = setupRepo()
  const home = tempDir('nodshell-ui-home-')
  const env = { ...r.env, HOME: home, NODSHELL_USER_DATA: join(home, 'userdata'), NODSHELL_TEST_RESTORE: 'choose' }
  let l = await launch(env)
  try {
    await openRepo(l.page)
    await spawnPreset(l.page, 'Backend', 2)
    await expect(l.page.getByTestId('agent-node')).toHaveCount(2)
    await expect.poll(() => r.runs().length, { timeout: 60_000 }).toBe(2)
    await l.page.waitForTimeout(800)
    await l.app.close()
    l = await launch(env)
    l.page.setDefaultTimeout(8000)
    const d = l.page.getByRole('dialog', { name: 'Choose terminals to open' })
    await d.waitFor()
    await shot(l.page, 'dialog-restore-choose', d, 20)
    await measureHits(l.page, 'restore dialog')
    await d.getByRole('checkbox').first().check()
    await shot(l.page, 'dialog-restore-choose-selected', d, 20)
    await states(l.page, 'restore-open-selected', d.getByRole('button', { name: /^Open \d+ selected/ }), [], ['normal', 'hover', 'pressed', 'focus'])
    await d.getByRole('button', { name: /^Open \d+ selected/ }).click()
  } catch (e) {
    skip('dialog-restore-choose', `error: ${String(e instanceof Error ? e.message : e).split('\n')[0]?.slice(0, 200)}`)
  } finally {
    await l.app.close()
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Runs last, in whatever worker: builds the index and the hit-target report from what the earlier tests left on disk.

test('zz index and hit targets', () => {
  const lines = (f: string) => {
    try {
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string | number | boolean>)
    } catch {
      return []
    }
  }
  const notes = lines(NOTES)
  const pngs = readdirSync(OUT).filter((f) => f.startsWith(`${PREFIX}-`) && f.endsWith('.png')).sort()
  const made = new Set(pngs.map((f) => f.slice(PREFIX.length + 1, -4)))
  const skipped = notes.filter((n) => 'skip' in n && !made.has(String(n['skip'])))
  const uncaught = [
    ['bypass-tag', 'BYPASS tag: no UI turns bypass on, so it is not reachable cheaply'],
  ]
  const md = [
    `# UI catalogue: ${PREFIX}`,
    '',
    `${pngs.length} PNGs. Names are <component>-<state>; "disabled" in a name means the control was aria-disabled or disabled when captured.`,
    '',
    '## Skipped or failed captures',
    ...(skipped.length ? skipped.map((s) => `- ${s['skip']}: ${s['reason']}`) : ['- none']),
    ...uncaught.map(([n, why]) => `- ${n}: ${why}`),
    '',
    '## Notes',
    ...notes.filter((n) => 'note' in n).map((n) => `- ${n['note']}: ${n['text']}`),
    '',
    '## Files',
    ...pngs.map((f) => `- ${f}`),
    '',
  ].join('\n')
  writeFileSync(join(OUT, `${PREFIX}-index.md`), md)

  const all = lines(HITS) as unknown as { where: string; label: string; width: number; height: number; effectiveHitWidth: number; effectiveHitHeight: number; covered: boolean; zoom?: number }[]
  const unique = new Map<string, (typeof all)[number] & { seenIn: string[] }>()
  for (const h of all) {
    const k = `${h.label}|${h.width}x${h.height}|${h.zoom ?? 1}`
    const e = unique.get(k)
    if (e) {
      if (!e.seenIn.includes(h.where)) e.seenIn.push(h.where)
    }
    else unique.set(k, { ...h, seenIn: [h.where] })
  }
  const controls = [...unique.values()]
  // sizes are on screen: a control on a board zoomed below 1 is measured scaled (the same control then appears once per size)
  const under36 = controls.filter((c) => !c.covered && (c.effectiveHitWidth < 36 || c.effectiveHitHeight < 36))
  const under36Both = under36.filter((c) => c.effectiveHitWidth < 36 && c.effectiveHitHeight < 36)
  // the 36 px minimum is for zoom 1: the chrome, and the board when it is not zoomed out
  const atZoom1 = controls.filter((c) => !c.covered && Math.abs((c.zoom ?? 1) - 1) < 0.001)
  const under36AtZoom1 = atZoom1.filter((c) => c.effectiveHitWidth < 36 || c.effectiveHitHeight < 36)
  writeFileSync(join(OUT, `${PREFIX}-hit-targets.json`), JSON.stringify({ total: controls.length, under36Count: under36.length, under36BothCount: under36Both.length, atZoom1Count: atZoom1.length, under36AtZoom1Count: under36AtZoom1.length, under36AtZoom1, under36Both, under36, controls }, null, 1))
  expect(pngs.length).toBeGreaterThan(0)
})

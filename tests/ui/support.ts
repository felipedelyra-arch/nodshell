// Capture helpers of the UI catalogue (catalogue.spec.ts): clipped screenshots, interaction states, hit-target probing.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'

export const ROOT = resolve(__dirname, '../..')
export const OUT = process.env['NODSHELL_UI_SHOTS'] ?? join(ROOT, 'tests/ui/out')
export const PREFIX = process.env['NODSHELL_UI_PREFIX'] ?? 'shot'
export const NOTES = join(OUT, `${PREFIX}-notes.jsonl`)
export const HITS = join(OUT, `${PREFIX}-hits.jsonl`)
mkdirSync(OUT, { recursive: true })

const log = (file: string, o: unknown) => appendFileSync(file, `${JSON.stringify(o)}\n`)
export const skip = (name: string, reason: string) => log(NOTES, { skip: name, reason })
export const note = (name: string, text: string) => log(NOTES, { note: name, text })

/** One capture section: a failure becomes a SKIPPED line in the index instead of losing the rest of the test. */
export async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    skip(name, `error: ${String(e instanceof Error ? e.message : e).split("\n").slice(0, 4).join(" | ").slice(0, 360)}`)
  }
}

type Margin = number | { x: number; y: number }
const M = 12

/** PNG of the union of `targets` plus a margin (device scale 1). Never overwrites: a name is one component and state. */
export async function shot(page: Page, name: string, targets: Locator | Locator[], margin: Margin = M): Promise<boolean> {
  const file = join(OUT, `${PREFIX}-${name}.png`)
  if (existsSync(file)) return true
  const boxes = []
  for (const t of Array.isArray(targets) ? targets : [targets]) {
    const b = await t.first().boundingBox().catch(() => null)
    if (b && b.width > 0 && b.height > 0) boxes.push(b)
  }
  if (!boxes.length) {
    skip(name, 'target not visible')
    return false
  }
  const [W, H] = await page.evaluate(() => [innerWidth, innerHeight] as const)
  const mx = typeof margin === 'number' ? margin : margin.x
  const my = typeof margin === 'number' ? margin : margin.y
  const x1 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - mx)
  const y1 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - my)
  const x2 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.width)) + mx)
  const y2 = Math.min(H, Math.max(...boxes.map((b) => b.y + b.height)) + my)
  // a settled picture: a hover or focus transition caught half-way would differ from run to run
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined)))).catch(() => undefined)
  await page.screenshot({ path: file, clip: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } })
  return true
}

/** The mouse on a spot with nothing under it (the pane, else the right edge). */
export async function park(page: Page): Promise<void> {
  const p = await page.evaluate(() => {
    for (let y = 80; y < innerHeight - 170; y += 20) for (let x = 90; x < innerWidth - 20; x += 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
    return { x: innerWidth - 4, y: innerHeight / 2 }
  })
  await page.mouse.move(p.x, p.y)
}

export const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

/** Keyboard focus that shows :focus-visible (a key first, then focus()). */
export async function focusVisible(page: Page, name: string, loc: Locator): Promise<void> {
  await page.keyboard.press('Shift')
  await loc.focus()
  if (!(await loc.evaluate((el) => el.matches(':focus-visible')))) note(name, 'focus() did not match :focus-visible')
}

/**
 * The control's real :active style without a click: a held mouse button would click it (close, maximize, ...) or drag the board
 * with the mouse, so the pseudo-class is forced through DevTools instead.
 */
async function forceActive(page: Page, loc: Locator): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page)
  await loc.first().evaluate((e) => e.setAttribute('data-ui-force', ''))
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-ui-force]' })
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] })
  return async () => {
    await cdp.detach().catch(() => undefined) // the forced state lives as long as the session
    await loc.first().evaluate((e) => e.removeAttribute('data-ui-force')).catch(() => undefined)
  }
}

/**
 * normal / hover / pressed / focus of one control (the names say "disabled" for an aria-disabled or disabled control).
 * Hover and focus also take the control's data-tip, which is drawn by a pseudo-element next to it.
 */
export async function states(page: Page, comp: string, loc: Locator, extra: Locator[] = [], only: string[] = ['normal', 'hover', 'pressed', 'focus']): Promise<void> {
  const el = loc.first()
  const dis = await el.evaluate((e) => e.getAttribute('aria-disabled') === 'true' || (e as HTMLButtonElement).disabled === true)
  const tip = await el.evaluate((e) => e.hasAttribute('data-tip'))
  const sfx = dis ? '-disabled' : ''
  const big: Margin = tip ? { x: 200, y: 56 } : M
  const targets = [el, ...extra]
  const run = async (state: string, fn: () => Promise<void>, m: Margin) => {
    if (!only.includes(state)) return
    const name = `${comp}-${state === 'normal' ? (dis ? 'disabled' : 'normal') : state + sfx}`
    await step(name, async () => {
      await fn()
      await shot(page, name, targets, m)
    })
  }
  await run('normal', () => park(page), M)
  await run('hover', () => el.hover({ timeout: 5000 }), big)
  let release: (() => Promise<void>) | undefined
  await run('pressed', async () => {
    await el.hover({ timeout: 5000 })
    release = await forceActive(page, el)
  }, M)
  await release?.()
  await run('focus', async () => {
    await park(page)
    await focusVisible(page, `${comp}-focus`, el)
  }, big)
  await blur(page)
  await park(page)
}

/** The control's busy look (aria-busy, as while its action waits for an answer), forced like the pressed state: no real action is left hanging. */
export async function busyShot(page: Page, comp: string, loc: Locator, extra: Locator[] = []): Promise<void> {
  await step(`${comp}-busy`, async () => {
    const el = loc.first()
    await park(page)
    await el.evaluate((e) => e.setAttribute('aria-busy', 'true'))
    await page.emulateMedia({ reducedMotion: 'reduce' }) // the still form of the indicator: the same picture in every run
    await shot(page, `${comp}-busy`, [el, ...extra])
    await page.emulateMedia({ reducedMotion: null })
    await el.evaluate((e) => e.removeAttribute('aria-busy'))
  })
}

/**
 * On-screen hit size of every visible interactive control, with the extent a ::before/::after or its <label> adds (probed outward, pixel by
 * pixel, up to 16). `zoom` is the board zoom for a control on the board and 1 for the chrome: only zoom 1 is held to the 36 px minimum.
 */
export async function measureHits(page: Page, where: string): Promise<void> {
  const rows = await page.evaluate(() => {
    const out: { label: string; width: number; height: number; effectiveHitWidth: number; effectiveHitHeight: number; covered: boolean; zoom: number }[] = []
    const view = document.querySelector('.react-flow__viewport')
    const boardZoom = view ? Math.round(new DOMMatrix(getComputedStyle(view).transform).a * 1000) / 1000 : 1
    const seen = new Set<string>()
    for (const el of document.querySelectorAll<HTMLElement>('button, [role=button], a, input, [role=tab], [role=menuitem]')) {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue
      const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && !c.startsWith('react-flow') && !/^(nodrag|nopan|nowheel)$/.test(c)).slice(0, 2).join('.')
      const label = `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} "${text}"`
      const key = `${label}@${Math.round(r.x)},${Math.round(r.y)}`
      if (seen.has(key)) continue
      seen.add(key)
      const hits = (x: number, y: number) => {
        const t = document.elementFromPoint(x, y)
        // a click on the control's own label lands on the control
        return !!t && (t === el || el.contains(t) || [...((el as HTMLInputElement).labels ?? [])].some((l) => l === t || l.contains(t)))
      }
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      const covered = !hits(cx, cy)
      let l = 0
      let rt = 0
      let t = 0
      let b = 0
      if (!covered) {
        for (let d = 1; d <= 16; d += 1) {
          // the middle of the d-th pixel outside each edge
          if (hits(r.left - d + 0.5, cy)) l = d
          if (hits(r.right + d - 0.5, cy)) rt = d
          if (hits(cx, r.top - d + 0.5)) t = d
          if (hits(cx, r.bottom + d - 0.5)) b = d
        }
      }
      out.push({ label, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, effectiveHitWidth: Math.round((r.width + l + rt) * 10) / 10, effectiveHitHeight: Math.round((r.height + t + b) * 10) / 10, covered, zoom: el.closest('.react-flow__viewport') ? boardZoom : 1 })
    }
    return out
  })
  for (const r of rows) log(HITS, { where, ...r })
}

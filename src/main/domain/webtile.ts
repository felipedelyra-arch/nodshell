// Pure web tile rules: what a tile may load and what of a page the app shows. No Electron.
import { ADDRESS_MAX, ADDRESS_SHOWN_MAX, intersect, PAGE_ZOOM, SHOWN_SIDE_MIN, TITLE_MAX, type Box, type PageWidth } from '../../shared/webtile'
import { cleanLine } from './task'

export class WebTileError extends Error {}

const BLANK = 'about:blank'
// a scheme as the URL parser reads it; "localhost:3000" is a host and a port, not a scheme
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i
// eslint-disable-next-line no-control-regex -- tabs and line breaks are dropped by the URL parser ("java\tscript:"), so they are refused
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/

/** localhost, *.localhost, loopback and private IPv4, IPv6 loopback: assumed to be a local dev server (plain http). */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '0.0.0.0') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** An address a tile may be at: http or https without a user or password, or about:blank. */
export function isAllowedWebUrl(url: string): boolean {
  if (url === BLANK) return true
  if (url.length > ADDRESS_MAX) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

/**
 * What the user typed, as the address a tile loads. Only http and https (and about:blank); no user or password; no control or space
 * character anywhere; at most ADDRESS_MAX. Without a scheme: http for a local host, https for anything else. Throws a short message.
 */
export function normalizeAddress(typed: string): string {
  const s = typed.trim()
  if (s === '' || s.length > ADDRESS_MAX) throw new WebTileError('Type an address of up to 2048 characters')
  if (CONTROL_OR_SPACE.test(s)) throw new WebTileError('The address cannot contain spaces or control characters')
  if (s.toLowerCase() === BLANK) return BLANK
  let candidate = s
  if (SCHEME.test(s)) {
    if (!/^https?:\/\//i.test(s)) throw new WebTileError('Only http and https addresses are allowed')
  } else {
    const host = s.split(/[/?#]/, 1)[0]!.replace(/:\d*$/, '')
    candidate = `${isLocalHost(host) ? 'http' : 'https'}://${s}`
  }
  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    throw new WebTileError('That is not a valid address')
  }
  const authority = candidate.slice(candidate.indexOf('//') + 2).split(/[/?#\\]/, 1)[0]!
  if (u.username !== '' || u.password !== '' || authority.includes('@')) throw new WebTileError('Addresses with a user name or password are not allowed')
  if (!isAllowedWebUrl(u.href)) throw new WebTileError(u.href.length > ADDRESS_MAX ? 'Type an address of up to 2048 characters' : 'Only http and https addresses are allowed')
  return u.href
}

/** Whether a page may go to `url`: the same rule as a typed address (http, https, about:blank; never with credentials). Subframes may also be about:srcdoc. */
export function mayNavigate(url: string, mainFrame: boolean): boolean {
  return isAllowedWebUrl(url) || (!mainFrame && url === 'about:srcdoc')
}

/** A page title for the title bar: one line, no control or format characters, at most TITLE_MAX. */
export function cleanTitle(raw: string): string {
  const t = cleanLine(raw).replace(/\s+/g, ' ').trim()
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

/** What the renderer is shown of an address: origin and path only (a query or fragment may carry a token), at most ADDRESS_SHOWN_MAX. */
export function shownAddress(url: string): string {
  if (url === BLANK) return BLANK
  try {
    const u = new URL(url)
    const s = cleanLine(`${u.origin}${u.pathname}`)
    return s.length > ADDRESS_SHOWN_MAX ? `${s.slice(0, ADDRESS_SHOWN_MAX - 1)}…` : s
  } catch {
    return ''
  }
}


// What stopped, from a closed list: a raw value Electron adds later never reaches the record.
const GONE_REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const
const CHILD_TYPES = ['Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown'] as const
export const FAILURES_MAX = 10
/** Reason codes only: never an address, title, origin or page content. */
export type Failure = { at: number; kind: 'gone' | 'unresponsive' | 'child' | 'app-renderer'; reason: string; exitCode: number | null; type?: string }

export const goneReason = (raw: unknown): string => ((GONE_REASONS as readonly unknown[]).includes(raw) ? (raw as string) : 'other')
export const childType = (raw: unknown): string => ((CHILD_TYPES as readonly unknown[]).includes(raw) ? (raw as string) : 'other')

/** The short text a tile shows for a gone page (no colon; at most 100 characters). */
export function goneText(reason: string): string {
  switch (reason) {
    case 'oom':
    case 'memory-eviction':
      return 'The page ran out of memory. Reload it'
    case 'killed':
      return 'The page was stopped by the system. Reload it'
    case 'crashed':
    case 'abnormal-exit':
      return 'The page crashed. Reload it'
    case 'launch-failed':
    case 'integrity-failure':
      return 'The page could not start. Reload it'
    default:
      return 'The page stopped, reload it'
  }
}
export const NOT_RESPONDING = 'The page is not responding. Wait or reload it'

/** The last FAILURES_MAX records, newest last. */
export const pushFailure = (list: readonly Failure[], f: Failure): Failure[] => [...list, f].slice(-FAILURES_MAX)

/**
 * Where a tile's page goes in the window (DIP) from its body and the board's free area as the renderer measured them (CSS px), each
 * scaled by the app page's own zoom factor (Ctrl+Plus would otherwise move it over the chrome), then rounded. `clip`: the part of the
 * area inside the free area and the window (only that part is drawn). `page`: the whole area, relative to the clip, so the page keeps
 * its size whatever the clip. `show`: the clip is big enough to be worth showing and the body (the page is drawn whole) is at most PAGE_SPAN_MAX times the window on each side.
 * `pageWidth` (a viewport preset): the page lays out at that many CSS px whatever the body's size. Mobile and Tablet never upscale: a
 * body wider than the preset gets a centred area of exactly that width at zoom 1; otherwise (and for Desktop) the page zoom is body ÷ width.
 * `zoom`: the page zoom this asks for, null = the caller's (the board zoom).
 */
/** A page this many times the window's content size (per side) is never drawn: its raster could exhaust GPU and RAM. */
export const PAGE_SPAN_MAX = 2

export function viewBounds(cssBody: Box, cssFree: Box, zoomFactor: number, content: { width: number; height: number }, pageWidth: PageWidth | null = null): { clip: Box; page: Box; show: boolean; zoom: number | null } {
  const k = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const dip = (b: Box): Box => ({ x: Math.round(b.x * k), y: Math.round(b.y * k), width: Math.round(b.width * k), height: Math.round(b.height * k) })
  const body = dip(cssBody)
  let area = body
  let zoom: number | null = null
  if (pageWidth !== null && body.width > 0) {
    if (pageWidth < 1440 && body.width > pageWidth) {
      area = { ...body, x: body.x + Math.round((body.width - pageWidth) / 2), width: pageWidth }
      zoom = 1
    } else zoom = Math.min(PAGE_ZOOM.max, Math.max(PAGE_ZOOM.min, body.width / pageWidth))
  }
  const clip = intersect(intersect(area, dip(cssFree)), { x: 0, y: 0, ...content }) // never trusts a free area past the window
  const page = { x: area.x - clip.x, y: area.y - clip.y, width: area.width, height: area.height }
  return { clip, page, show: clip.width >= SHOWN_SIDE_MIN && clip.height >= SHOWN_SIDE_MIN && body.width <= PAGE_SPAN_MAX * content.width && body.height <= PAGE_SPAN_MAX * content.height, zoom }
}

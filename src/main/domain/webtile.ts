// Pure web tile rules: what a tile may load and what of a page the app shows. No Electron.
import { ADDRESS_MAX, ADDRESS_SHOWN_MAX, TITLE_MAX } from '../../shared/webtile'
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


export type Box = { x: number; y: number; width: number; height: number }

/**
 * Where a tile's view goes in the window (DIP) from its body as the renderer measured it (CSS px): scaled by the app page's own zoom
 * factor (Ctrl+Plus would otherwise move it over the chrome), then rounded. `inside`: the whole box lies within the window's content.
 */
export function viewBounds(css: Box, zoomFactor: number, content: { width: number; height: number }): { bounds: Box; inside: boolean } {
  const k = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const bounds = { x: Math.round(css.x * k), y: Math.round(css.y * k), width: Math.round(css.width * k), height: Math.round(css.height * k) }
  const inside = bounds.width >= 1 && bounds.height >= 1 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= content.width && bounds.y + bounds.height <= content.height
  return { bounds, inside }
}

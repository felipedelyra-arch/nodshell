// Spots a localhost address in a terminal's output so the app can OFFER a web tile. The output is data: this only proposes an address.
import { stripAnsi } from './loop'
import { isAllowedWebUrl, normalizeAddress } from './webtile'

export const SUGGEST_ADDRESS_MAX = 200
export const SUGGEST_WINDOW_MS = 10_000
export const SUGGEST_SEEN_MAX = 64 // origins remembered per terminal, oldest evicted
const TAIL_MAX = 256
const CHUNK_MAX = 64 * 1024
/** the one shape ever offered (the IPC schema checks it again) */
export const SUGGEST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:\/[A-Za-z0-9._~/-]*)?$/
const FIND = /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)((?:\/[A-Za-z0-9._~/-]*)?)/gi

/**
 * One offer at a time per window: an origin (scheme, host, port) once per terminal, one per 10 s per window (later ones are dropped), none when
 * `allowed` says no (tile limit, or a tile already there). A query or fragment is cut off (the page opens without it); an address
 * still touching the end of the output waits for the next chunk. Only the last 256 raw characters are kept between chunks.
 */
export class UrlSuggester {
  private tails = new Map<string, string>()
  private seen = new Map<string, Set<string>>()
  private last = new Map<number, number>()
  constructor(
    private now: () => number,
    private allowed: (ownerId: number, address: string) => boolean,
  ) {}

  feed(ownerId: number, terminalId: string, chunk: string): string | null {
    const flood = chunk.length > CHUNK_MAX // a flood is not scanned in full: only its last characters count
    const c = flood ? chunk.slice(-TAIL_MAX) : chunk
    const hay = (flood ? '' : (this.tails.get(terminalId) ?? '')) + c
    this.tails.set(terminalId, hay.slice(-TAIL_MAX))
    if (!hay.includes('://')) return null
    const text = stripAnsi(hay)
    FIND.lastIndex = 0
    for (let m = FIND.exec(text); m; m = FIND.exec(text)) {
      const next = text[m.index + m[0].length]
      if (next === undefined || next === '@' || /\d/.test(next)) continue // unfinished, userinfo, or a longer port
      const port = Number(m[3])
      if (port < 1 || port > 65535 || m[3]!.length > 5) continue
      const h = m[2]!.toLowerCase()
      const address = `${m[1]!.toLowerCase()}://${h === '0.0.0.0' ? 'localhost' : h}:${port}${m[4]!.replace(/\.+$/, '')}`
      if (address.length > SUGGEST_ADDRESS_MAX || !SUGGEST_RE.test(address)) continue
      try {
        if (!isAllowedWebUrl(normalizeAddress(address))) continue
      } catch {
        continue
      }
      const origin = new URL(address).origin
      let set = this.seen.get(terminalId)
      if (set?.has(origin)) continue
      if (!this.allowed(ownerId, address)) continue
      if (!set) this.seen.set(terminalId, (set = new Set()))
      set.add(origin) // only what `allowed` let through is remembered
      if (set.size > SUGGEST_SEEN_MAX) set.delete(set.values().next().value as string)
      const t = this.now()
      if (t - (this.last.get(ownerId) ?? -Infinity) < SUGGEST_WINDOW_MS) continue // dropped, not queued
      this.last.set(ownerId, t)
      return address
    }
    return null
  }

  tailLength(terminalId: string): number {
    return this.tails.get(terminalId)?.length ?? 0
  }

  seenSize(terminalId: string): number {
    return this.seen.get(terminalId)?.size ?? 0
  }

  forget(terminalId: string): void {
    this.tails.delete(terminalId)
    this.seen.delete(terminalId)
  }
}

import { describe, expect, it } from 'vitest'
import { SUGGEST_SEEN_MAX, UrlSuggester } from '../../src/main/domain/urlsuggest'
import { events } from '../../src/shared/ipc/channels'

const T = 't1'
function make(allowed = () => true) {
  let t = 0
  const s = new UrlSuggester(() => t, allowed)
  return { s, tick: (ms: number) => void (t += ms) }
}
/** the first address offered when `chunks` arrive one after the other */
const offer = (...chunks: string[]) => {
  const { s } = make()
  return chunks.map((c) => s.feed(1, T, c)).find((a) => a !== null) ?? null
}

describe('UrlSuggester', () => {
  it('recognises loopback addresses', () => {
    expect(offer('ready on http://localhost:3000\n')).toBe('http://localhost:3000')
    expect(offer('http://localhost:3000/app/x.html \n')).toBe('http://localhost:3000/app/x.html')
    expect(offer('\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n')).toBe('http://localhost:5173/')
    expect(offer('see https://127.0.0.1:8443/app\r\n')).toBe('https://127.0.0.1:8443/app')
    expect(offer('http://0.0.0.0:8080\n')).toBe('http://localhost:8080')
    expect(offer('at http://[::1]:3000\n')).toBe('http://[::1]:3000')
  })

  it('finds an address (and an escape sequence) split across chunks at every position', () => {
    for (const text of ['go http://localhost:3000/a\n', '\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n']) {
      const expected = offer(text)
      expect(expected).not.toBeNull()
      for (let i = 1; i < text.length; i++) expect(offer(text.slice(0, i), text.slice(i)), `${i}`).toBe(expected)
    }
  })

  it('waits for the end of an address and ignores trailing punctuation', () => {
    const { s } = make()
    expect(s.feed(1, T, 'http://localhost:30')).toBeNull()
    expect(s.feed(1, T, '00')).toBeNull()
    expect(s.feed(1, T, '.\n')).toBe('http://localhost:3000')
    for (const end of ['.', ',', ')', '"', "'"]) expect(offer(`(http://localhost:3000/x${end} \n`)).toBe('http://localhost:3000/x')
    expect(offer('http://localhost:3000/x.\n')).toBe('http://localhost:3000/x')
  })

  it('ignores everything else', () => {
    for (const bad of [
      'http://localhost/\n', 'http://localhost:0/\n', 'http://localhost:70000/\n', 'http://localhost:123456/\n', 'http://evil.com:80/\n',
      'http://localhost.evil.com:3000/\n', 'http://localhost:3000@evil.com/\n', 'http://user:pw@localhost:3000\n', 'file:///etc/passwd\n',
      'javascript://localhost:3000\n', 'ftp://localhost:3000\n', `http://localhost:3000/${'a'.repeat(200)}\n`, 'http://example.com:80/\n',
    ]) expect(offer(bad), bad).toBeNull()
  })

  it('cuts a query and a fragment off', () => {
    expect(offer('http://localhost:3000/a?token=1\n')).toBe('http://localhost:3000/a')
    expect(offer('http://localhost:3000#frag\n')).toBe('http://localhost:3000')
  })

  it('offers an address once per terminal, one per 10 s per window', () => {
    const { s, tick } = make()
    expect(s.feed(1, T, 'http://localhost:3000\n')).toBe('http://localhost:3000')
    expect(s.feed(1, T, 'http://localhost:3000\n')).toBeNull()
    expect(s.feed(1, T, 'http://localhost:3001\n')).toBeNull() // inside the window: dropped
    tick(10_000)
    expect(s.feed(1, T, 'http://localhost:3001\n')).toBeNull() // and not queued
    expect(s.feed(1, T, 'http://localhost:3002\n')).toBe('http://localhost:3002')
    expect(s.feed(2, 'other', 'http://localhost:3002\n')).toBe('http://localhost:3002') // another window and terminal
    s.forget(T)
    tick(10_000)
    expect(s.feed(1, T, 'http://localhost:3000\n')).toBe('http://localhost:3000')
  })

  it('is keyed by origin and bounded per terminal', () => {
    const { s, tick } = make()
    let offers = 0
    for (let i = 0; i < 1000; i++) {
      tick(10_000)
      if (s.feed(1, T, `http://localhost:3000/p${i}\n`)) offers++
    }
    expect(offers).toBe(1)
    expect(s.seenSize(T)).toBe(1)
    for (let i = 0; i < 1000; i++) {
      tick(10_000)
      s.feed(1, T, `http://localhost:${4000 + i}\n`)
    }
    expect(s.seenSize(T)).toBeLessThanOrEqual(SUGGEST_SEEN_MAX)
  })

  it('offers nothing when the window may not open it', () => {
    const { s } = make(() => false)
    expect(s.feed(1, T, 'http://localhost:3000\n')).toBeNull()
  })

  it('keeps a bounded tail and skips the body of a flood', () => {
    const { s } = make()
    s.feed(1, T, 'x'.repeat(5000))
    expect(s.tailLength(T)).toBe(256)
    expect(s.feed(1, T, `http://localhost:3000\n${'y\n'.repeat(40_000)}`)).toBeNull() // 80 KB: only its end is read
    s.forget(T)
    expect(s.tailLength(T)).toBe(0)
  })

  it('scans 50 MB of output in well under 100 ms per MB', () => {
    const { s } = make()
    const chunk = 'y\n'.repeat(8192) // 16 KB
    const n = (50 * 1024 * 1024) / chunk.length
    const t0 = performance.now()
    for (let i = 0; i < n; i++) s.feed(1, T, chunk)
    const perMb = (performance.now() - t0) / 50
    console.log(`scan cost: ${perMb.toFixed(2)} ms/MB`)
    expect(perMb).toBeLessThan(100)
  })

  it('the event schema refuses a non-loopback address', () => {
    const ok = { terminalId: crypto.randomUUID(), address: 'http://localhost:3000/a' }
    expect(events['webtile:suggest'].safeParse(ok).success).toBe(true)
    for (const address of ['http://evil.com:80/', 'http://localhost:3000@evil.com/', 'http://localhost:3000/a?b=1', 'file:///etc/passwd', 'http://localhost']) {
      expect(events['webtile:suggest'].safeParse({ ...ok, address }).success, address).toBe(false)
    }
  })
})

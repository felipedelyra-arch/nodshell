import { describe, expect, it } from 'vitest'
import { cleanTitle, isAllowedWebUrl, isLocalHost, mayNavigate, normalizeAddress, shownAddress, viewBounds } from '../../src/main/domain/webtile'
import { ADDRESS_MAX, ADDRESS_SHOWN_MAX, TITLE_MAX } from '../../src/shared/webtile'
import { contains, freeArea, tileVisible, type TileUi } from '../../src/renderer/webtile/visibility'

const ch = (code: number) => String.fromCharCode(code)

describe('normalizeAddress', () => {
  it('keeps http and https addresses (normalized by the URL parser)', () => {
    expect(normalizeAddress('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeAddress('https://Example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(normalizeAddress('  HTTP://127.0.0.1:8080/x  ')).toBe('http://127.0.0.1:8080/x')
    expect(normalizeAddress('about:blank')).toBe('about:blank')
  })
  it('without a scheme: http for a local host, https for anything else', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeAddress('localhost')).toBe('http://localhost/')
    expect(normalizeAddress('app.localhost:3000/x')).toBe('http://app.localhost:3000/x')
    expect(normalizeAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(normalizeAddress('192.168.1.20/dash')).toBe('http://192.168.1.20/dash')
    expect(normalizeAddress('10.0.0.5')).toBe('http://10.0.0.5/')
    expect(normalizeAddress('[::1]:3000')).toBe('http://[::1]:3000/')
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('example.com:8443/p')).toBe('https://example.com:8443/p')
    expect(normalizeAddress('172.32.0.1')).toBe('https://172.32.0.1/') // not private
  })
  it('refuses every other scheme, whatever its case', () => {
    for (const a of ['file:///etc/passwd', 'FILE:///etc/passwd', 'app://app/index.html', 'chrome://settings', 'devtools://devtools/x', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'blob:http://localhost/1', 'view-source:http://localhost', 'ftp://x.org', 'ws://localhost:1', 'mailto:a@b.c', 'about:config', 'chrome-extension://x/y']) {
      expect(() => normalizeAddress(a), a).toThrow(/http and https/)
    }
  })
  it('refuses a scheme disguised with tabs, line breaks or other invisible characters', () => {
    for (const a of [`java${ch(9)}script:alert(1)`, `java${ch(10)}script:alert(1)`, `${ch(13)}javascript:alert(1)`, `jav${ch(0)}ascript:x`, `http://local${ch(0x200b)}host`, `http://exa mple.com`, `http://localhost/a${ch(0x2028)}b`]) {
      expect(() => normalizeAddress(a), JSON.stringify(a)).toThrow()
    }
    // leading and trailing spaces are only trimmed
    expect(normalizeAddress(` ${ch(9)}localhost:3000 `)).toBe('http://localhost:3000/')
  })
  it('refuses a user name or password in the address', () => {
    for (const a of ['http://user:pass@localhost:3000', 'https://user@example.com', 'http://@example.com', 'example.com@evil.com', 'localhost:1@evil.com']) expect(() => normalizeAddress(a), a).toThrow(/user name or password/)
    expect(() => normalizeAddress('user:pw@example.com')).toThrow() // read as the scheme user:
  })
  it('refuses an empty, invalid or too long address', () => {
    expect(() => normalizeAddress('   ')).toThrow()
    expect(() => normalizeAddress('http://')).toThrow()
    expect(() => normalizeAddress('https://[nope')).toThrow()
    expect(() => normalizeAddress(`https://example.com/${'a'.repeat(ADDRESS_MAX)}`)).toThrow(/2048/)
    expect(normalizeAddress(`https://example.com/${'a'.repeat(ADDRESS_MAX - 30)}`)).toMatch(/^https:/)
  })
})

describe('navigation', () => {
  it('a page may go to http, https and about:blank only', () => {
    expect(mayNavigate('http://localhost:3000/next', true)).toBe(true)
    expect(mayNavigate('https://example.com/', true)).toBe(true)
    expect(mayNavigate('about:blank', true)).toBe(true)
    for (const u of ['file:///etc/passwd', 'app://app/index.html', 'chrome://gpu', 'devtools://x', 'javascript:alert(1)', 'data:text/html,x', 'blob:http://localhost/u', 'view-source:http://localhost/', 'http://user:pw@localhost/', 'about:srcdoc', 'not a url', '']) {
      expect(mayNavigate(u, true), u).toBe(false)
    }
  })
  it('a subframe may also be about:srcdoc', () => {
    expect(mayNavigate('about:srcdoc', false)).toBe(true)
    expect(mayNavigate('file:///etc/passwd', false)).toBe(false)
  })
  it('an address longer than the limit is not allowed', () => {
    expect(isAllowedWebUrl(`http://localhost/${'a'.repeat(ADDRESS_MAX)}`)).toBe(false)
  })
  it('knows the local hosts', () => {
    for (const h of ['localhost', 'LOCALHOST', 'a.localhost', '127.0.0.1', '127.9.9.9', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.255', '[::1]', '0.0.0.0']) expect(isLocalHost(h), h).toBe(true)
    for (const h of ['example.com', 'localhost.com', '172.15.0.1', '172.32.0.1', '8.8.8.8', '192.169.0.1', '']) expect(isLocalHost(h), h).toBe(false)
  })
})

describe('what the renderer is shown of a page', () => {
  it('a title is one clean line within the limit', () => {
    expect(cleanTitle(`  Hello${ch(10)}${ch(9)}world${ch(0)}${ch(0x1b)}[31m  `)).toBe('Hello world[31m')
    expect(cleanTitle(`a${ch(0x202e)}b${ch(0x200b)}c`)).toBe('abc') // bidi override and zero-width space gone
    const long = cleanTitle('x'.repeat(TITLE_MAX + 50))
    expect(long).toHaveLength(TITLE_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
  it('an address is origin and path only: never the query or the fragment', () => {
    expect(shownAddress('http://localhost:3000/a/b?token=secret#frag')).toBe('http://localhost:3000/a/b')
    expect(shownAddress('about:blank')).toBe('about:blank')
    expect(shownAddress('not a url')).toBe('')
    expect(shownAddress(`https://example.com/${'a'.repeat(1000)}`)).toHaveLength(ADDRESS_SHOWN_MAX)
  })
})

describe('tileVisible', () => {
  const win = { width: 1440, height: 900 }
  const free = freeArea(win, { top: 56, right: 24, bottom: 140, left: 76 })
  const ui: TileUi = { activeWorkspace: true, overlay: false, maximized: false, moving: false, selectTool: true, overlapped: false }
  const body = { x: 500, y: 200, width: 480, height: 300 }
  it('the free area is the window minus the chrome', () => {
    expect(free).toEqual({ x: 76, y: 56, width: 1340, height: 704 })
    expect(freeArea({ width: 50, height: 50 }, { top: 56, right: 24, bottom: 140, left: 76 })).toEqual({ x: 76, y: 56, width: 0, height: 0 })
  })
  it('shows a body wholly inside the free area with nothing over it', () => {
    expect(tileVisible(body, free, ui)).toBe(true)
    expect(contains(free, { x: 76, y: 56, width: 1340, height: 704 })).toBe(true) // touching the edges is inside
    expect(tileVisible({ x: 76, y: 56, width: 1340, height: 704 }, free, ui)).toBe(true)
  })
  it('hides it when it touches the chrome on any side', () => {
    expect(tileVisible({ ...body, y: 50 }, free, ui)).toBe(false) // under the top bar
    expect(tileVisible({ ...body, x: 60 }, free, ui)).toBe(false) // under the toolbar
    expect(tileVisible({ ...body, y: 500 }, free, ui)).toBe(false) // into the bottom bars
    expect(tileVisible({ ...body, x: 1000 }, free, ui)).toBe(false) // past the right margin
  })
  it('hides it whenever something of the app is, or may get, over it', () => {
    for (const k of ['overlay', 'maximized', 'moving', 'overlapped'] as const) expect(tileVisible(body, free, { ...ui, [k]: true }), k).toBe(false)
    expect(tileVisible(body, free, { ...ui, activeWorkspace: false })).toBe(false)
    expect(tileVisible(body, free, { ...ui, selectTool: false })).toBe(false)
  })
  it('hides a body too small or not measurable', () => {
    expect(tileVisible({ ...body, width: 10 }, free, ui)).toBe(false)
    expect(tileVisible({ ...body, x: Number.NaN }, free, ui)).toBe(false)
  })
})

describe('viewBounds', () => {
  const content = { width: 1440, height: 900 }
  it('turns the CSS px the renderer measured into window DIP by the app page zoom', () => {
    expect(viewBounds({ x: 100, y: 80, width: 400, height: 250 }, 1, content)).toEqual({ bounds: { x: 100, y: 80, width: 400, height: 250 }, inside: true })
    expect(viewBounds({ x: 100, y: 80, width: 400, height: 250 }, 1.25, content)).toEqual({ bounds: { x: 125, y: 100, width: 500, height: 313 }, inside: true })
    expect(viewBounds({ x: 100.4, y: 80, width: 400, height: 250 }, 0.8, content).bounds).toEqual({ x: 80, y: 64, width: 320, height: 200 })
  })
  it('checks the scaled box against the window, so a zoomed-in app never pushes the page past it', () => {
    expect(viewBounds({ x: 1000, y: 500, width: 400, height: 300 }, 1, content).inside).toBe(true)
    expect(viewBounds({ x: 1000, y: 500, width: 400, height: 300 }, 1.25, content).inside).toBe(false)
    expect(viewBounds({ x: -1, y: 0, width: 10, height: 10 }, 1, content).inside).toBe(false)
    expect(viewBounds({ x: 0, y: 0, width: 0, height: 10 }, 1, content).inside).toBe(false)
  })
  it('a factor that is not a positive number counts as 1', () => {
    expect(viewBounds({ x: 10, y: 10, width: 10, height: 10 }, Number.NaN, content).bounds).toEqual({ x: 10, y: 10, width: 10, height: 10 })
    expect(viewBounds({ x: 10, y: 10, width: 10, height: 10 }, 0, content).bounds).toEqual({ x: 10, y: 10, width: 10, height: 10 })
  })
})

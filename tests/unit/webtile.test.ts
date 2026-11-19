import { describe, expect, it } from 'vitest'
import { childType, cleanTitle, goneReason, goneText, pushFailure, type Failure, isAllowedWebUrl, isLocalHost, mayNavigate, normalizeAddress, shownAddress, viewBounds } from '../../src/main/domain/webtile'
import { ADDRESS_MAX, ADDRESS_SHOWN_MAX, PAGE_ZOOM, pageWidthOf, TITLE_MAX } from '../../src/shared/webtile'
import { channelNames } from '../../src/shared/ipc/names'
import { channels, events } from '../../src/shared/ipc/channels'
import { freeArea, tileVisible, type TileUi } from '../../src/renderer/webtile/visibility'

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
    expect(tileVisible({ x: 76, y: 56, width: 1340, height: 704 }, free, ui)).toBe(true)
  })
  it('still shows it when only part of it is in the free area (main draws that part)', () => {
    expect(tileVisible({ ...body, y: 50 }, free, ui)).toBe(true) // under the top bar
    expect(tileVisible({ ...body, x: 60 }, free, ui)).toBe(true) // under the toolbar
    expect(tileVisible({ ...body, y: 500 }, free, ui)).toBe(true) // into the bottom bars
    expect(tileVisible({ ...body, x: 1000 }, free, ui)).toBe(true) // past the right margin
    expect(tileVisible({ x: 0, y: 0, width: 3000, height: 2000 }, free, ui)).toBe(true) // bigger than the free area (zoomed in)
    // the default window: a 1024x640 body never fits its 1180x604 free area, yet shows
    expect(tileVisible({ x: 120, y: 90, width: 1024, height: 640 }, freeArea({ width: 1280, height: 800 }, { top: 56, right: 24, bottom: 140, left: 76 }), ui)).toBe(true)
  })
  it('hides it when (almost) nothing of it is in the free area', () => {
    expect(tileVisible({ ...body, y: 760 }, free, ui)).toBe(false) // wholly under the bottom bars
    expect(tileVisible({ ...body, y: 760 - 15 }, free, ui)).toBe(false) // 15 px left
    expect(tileVisible({ ...body, y: 760 - 16 }, free, ui)).toBe(true)
    expect(tileVisible({ ...body, x: -500 }, free, ui)).toBe(false) // off the window's left
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
  const all = { x: 0, y: 0, ...content }
  it('turns the CSS px the renderer measured into window DIP by the app page zoom', () => {
    expect(viewBounds({ x: 100, y: 80, width: 400, height: 250 }, all, 1, content)).toEqual({ clip: { x: 100, y: 80, width: 400, height: 250 }, page: { x: 0, y: 0, width: 400, height: 250 }, show: true, zoom: null })
    expect(viewBounds({ x: 100, y: 80, width: 400, height: 250 }, all, 1.25, content)).toEqual({ clip: { x: 125, y: 100, width: 500, height: 313 }, page: { x: 0, y: 0, width: 500, height: 313 }, show: true, zoom: null })
    expect(viewBounds({ x: 100.4, y: 80, width: 400, height: 250 }, all, 0.8, content).clip).toEqual({ x: 80, y: 64, width: 320, height: 200 })
  })
  it('clips the page to the free area and the window; the page keeps its whole size, offset from the clip', () => {
    const free = { x: 76, y: 56, width: 1180, height: 604 } // 1280x800 window
    expect(viewBounds({ x: 50, y: 30, width: 1300, height: 700 }, free, 1, { width: 1280, height: 800 })).toEqual({ clip: { x: 76, y: 56, width: 1180, height: 604 }, page: { x: -26, y: -26, width: 1300, height: 700 }, show: true, zoom: null })
    expect(viewBounds({ x: 200, y: 600, width: 400, height: 300 }, free, 1, { width: 1280, height: 800 })).toEqual({ clip: { x: 200, y: 600, width: 400, height: 60 }, page: { x: 0, y: 0, width: 400, height: 300 }, show: true, zoom: null })
    // a zoomed-in app: the scaled box is clipped to the window, never pushed past it
    const big = viewBounds({ x: 1000, y: 500, width: 400, height: 300 }, all, 1.25, content)
    expect(big.clip).toEqual({ x: 1250, y: 625, width: 190, height: 275 })
    expect(big.page).toEqual({ x: 0, y: 0, width: 500, height: 375 })
  })
  it('never trusts a free area past the window', () => {
    expect(viewBounds({ x: -100, y: -100, width: 5000, height: 5000 }, { x: -1000, y: -1000, width: 9000, height: 9000 }, 1, content).clip).toEqual(all)
  })
  it('shows nothing when less than 16 px of it is left on a side', () => {
    expect(viewBounds({ x: 0, y: 0, width: 0, height: 10 }, all, 1, content).show).toBe(false)
    expect(viewBounds({ x: 1425, y: 0, width: 400, height: 300 }, all, 1, content).show).toBe(false) // 15 px in the window
    expect(viewBounds({ x: 1424, y: 0, width: 400, height: 300 }, all, 1, content).show).toBe(true)
    expect(viewBounds({ x: 100, y: 100, width: 400, height: 300 }, { x: 600, y: 0, width: 100, height: 100 }, 1, content).show).toBe(false) // outside the free area
  })
  it('does not show a page whose body exceeds twice the window on either side', () => {
    const w = { width: 1280, height: 800 }
    const free = { x: 0, y: 0, ...w }
    expect(viewBounds({ x: 0, y: 0, width: 2560, height: 1600 }, free, 1, w).show).toBe(true)
    expect(viewBounds({ x: 0, y: 0, width: 2561, height: 1600 }, free, 1, w).show).toBe(false)
    expect(viewBounds({ x: 0, y: 0, width: 2560, height: 1601 }, free, 1, w).show).toBe(false)
    expect(viewBounds({ x: 0, y: 0, width: 1024, height: 640 }, free, 1, w).show).toBe(true)
  })
  it('maps every Electron reason to a short text without a colon', () => {
    const want: Record<string, string> = { oom: 'ran out of memory', 'memory-eviction': 'ran out of memory', killed: 'stopped by the system', crashed: 'crashed', 'abnormal-exit': 'crashed', 'launch-failed': 'could not start', 'integrity-failure': 'could not start', 'clean-exit': 'stopped, reload it', other: 'stopped, reload it' }
    for (const [r, t] of Object.entries(want)) {
      expect(goneText(r)).toContain(t)
      expect(goneText(r)).not.toContain(':')
      expect(goneText(r).length).toBeLessThanOrEqual(100)
    }
  })
  it('allow-lists the reason and the process type', () => {
    expect(goneReason('oom')).toBe('oom')
    expect(goneReason('https://x.test/secret')).toBe('other')
    expect(goneReason(undefined)).toBe('other')
    expect(childType('GPU')).toBe('GPU')
    expect(childType('whatever')).toBe('other')
  })
  it('keeps the last 10 failure records, newest last', () => {
    let l: Failure[] = []
    for (let i = 0; i < 12; i++) l = pushFailure(l, { at: i, kind: 'gone', reason: 'oom', exitCode: null })
    expect(l.map((f) => f.at)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
  it('a factor that is not a positive number counts as 1', () => {
    expect(viewBounds({ x: 10, y: 10, width: 10, height: 10 }, all, Number.NaN, content).clip).toEqual({ x: 10, y: 10, width: 10, height: 10 })
    expect(viewBounds({ x: 10, y: 10, width: 10, height: 10 }, all, 0, content).clip).toEqual({ x: 10, y: 10, width: 10, height: 10 })
  })
})

describe('viewport presets', () => {
  const all = { x: 0, y: 0, width: 1680, height: 1050 }
  const content = { width: 1680, height: 1050 }
  const bodies = [{ w: 240, h: 120 }, { w: 400, h: 300 }, { w: 1024, h: 640 }, { w: 1800, h: 900 }]
  it('lays the page out at exactly the preset width: zoom = body width / preset, or a centred area at zoom 1 for a narrow preset in a wider body', () => {
    for (const z of [0.5, 1, 1.5]) {
      for (const b of bodies) {
        for (const W of [390, 768, 1440] as const) {
          const body = { x: 100, y: 80, width: b.w * z, height: b.h * z }
          const r = viewBounds(body, all, 1, content, W)
          const bw = Math.round(body.width)
          // layout width = view width / page zoom
          const zoom = r.zoom ?? 1
          if (bw / W >= PAGE_ZOOM.min) expect(Math.abs(r.page.width / zoom - W)).toBeLessThanOrEqual(1) // below the zoom limit the page is simply wider than asked
          expect(zoom).toBeGreaterThanOrEqual(PAGE_ZOOM.min)
          expect(zoom).toBeLessThanOrEqual(PAGE_ZOOM.max)
          if (W < 1440 && bw > W) {
            expect(zoom).toBe(1)
            expect(r.page.width).toBe(W)
            // centred in the body and never past it
            expect(r.clip.x + r.page.x).toBe(100 + Math.round((bw - W) / 2))
          } else expect(r.clip.x + r.page.x).toBe(100)
          expect(r.clip.x).toBeGreaterThanOrEqual(100)
          expect(r.clip.x + r.clip.width).toBeLessThanOrEqual(100 + bw)
        }
      }
    }
  })
  it('Fit (null) is the body as before and asks for no zoom of its own', () => {
    expect(viewBounds({ x: 100, y: 80, width: 400, height: 250 }, all, 1, content, null).zoom).toBeNull()
  })
  it('still clips the page area to the free area and the window', () => {
    const free = { x: 76, y: 56, width: 1180, height: 604 }
    const r = viewBounds({ x: 50, y: 30, width: 1300, height: 700 }, free, 1, { width: 1280, height: 800 }, 390)
    expect(r.page).toEqual({ x: 0, y: -26, width: 390, height: 700 })
    expect(r.clip).toEqual({ x: 505, y: 56, width: 390, height: 604 })
  })
  it('a saved or sent width that is not a preset is Fit', () => {
    expect([390, 768, 1440].map(pageWidthOf)).toEqual([390, 768, 1440])
    expect([null, undefined, 0, 1000, '390', Number.NaN].map(pageWidthOf)).toEqual([null, null, null, null, null, null])
    const place = { id: '8f14e45f-ceea-467f-a0e6-3a1f9e1b0c11', x: 0, y: 0, width: 10, height: 10, free: { x: 0, y: 0, width: 10, height: 10 }, zoom: 1, visible: true }
    for (const w of [390, 768, 1440, null]) expect(channels['webtile:place'].in.safeParse({ ...place, pageWidth: w }).success).toBe(true)
    for (const w of [0, 1000, '390', undefined]) expect(channels['webtile:place'].in.safeParse({ ...place, pageWidth: w }).success).toBe(false)
  })
})

describe('web tile history channels and state', () => {
  const id = '8f14e45f-ceea-467f-a0e6-3a1f9e1b0c11'
  it('back and forward take only a tile id and answer ok, like reload', () => {
    for (const name of ['webtile:back', 'webtile:forward'] as const) {
      expect(channelNames).toContain(name)
      expect(channels[name].in.safeParse({ id }).success).toBe(true)
      expect(channels[name].in.safeParse({}).success).toBe(false)
      expect(channels[name].out.safeParse({ ok: true }).success).toBe(true)
    }
  })
  it('the changed event carries canGoBack and canGoForward as booleans', () => {
    const e = { id, title: 'T', address: 'http://localhost/', loading: false, error: null }
    expect(events['webtile:changed'].safeParse({ ...e, canGoBack: true, canGoForward: false }).success).toBe(true)
    expect(events['webtile:changed'].safeParse(e).success).toBe(false)
    expect(events['webtile:changed'].safeParse({ ...e, canGoBack: 'yes', canGoForward: false }).success).toBe(false)
  })
})

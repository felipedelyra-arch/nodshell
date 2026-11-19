import { session, View, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import { PAGE_ZOOM, WEBTILES_MAX, type Box, type PageWidth } from '../../shared/webtile'
import { cleanTitle, goneReason, goneText, isAllowedWebUrl, mayNavigate, NOT_RESPONDING, pushFailure, type Failure, shownAddress, viewBounds, WebTileError } from '../domain/webtile'

/** In memory only (no "persist:" prefix): nothing a page stores outlives the app. Shared by the tiles, never by the app window. */
const TILE_PARTITION = 'webtiles'
const tileContents = new WeakSet<WebContents>()
/** The last failures of pages and helper processes, in memory only. */
let failures: Failure[] = []
export const recordFailure = (f: Omit<Failure, 'at'>): void => void (failures = pushFailure(failures, { at: Date.now(), ...f }))
export const recentFailures = (): readonly Failure[] => failures
export const exitCodeOf = (d: { exitCode: number }): number | null => (Number.isInteger(d.exitCode) ? d.exitCode : null)
/** A tile's page: never an owner of terminals, never the app window, never a caller of the app's API. */
export const isTileContents = (wc: WebContents | null | undefined): boolean => !!wc && tileContents.has(wc)

export type TileState = { id: string; title: string; address: string; loading: boolean; error: string | null; canGoBack: boolean; canGoForward: boolean }
export type Placement = { id: string; x: number; y: number; width: number; height: number; free: Box; zoom: number; visible: boolean; pageWidth: PageWidth | null }
export type TileHooks = {
  /** the title, address, loading state or error of a tile changed (already cleaned) */
  state(ownerId: number, s: TileState): void
  /** F6 in the page gave the focus back to the app */
  returned(ownerId: number, id: string): void
  /** a tile was added, went elsewhere or was closed (the board is saved) */
  changed(ownerId: number): void
}

type Tile = {
  id: string
  ownerId: number
  workspaceId: string
  win: BrowserWindow
  /** the page's frame in the window: sized to the visible part of the body, it clips the page (and its clicks) to that part */
  clip: View
  view: WebContentsView
  url: string
  title: string
  loading: boolean
  error: string | null
  shown: boolean
  /** the user has not chosen the page (a click in it, or Enter on its tile): if it takes the keyboard focus (Electron focuses a page as it loads), the focus goes back to the app */
  keepAppFocus: boolean
  zoom: number
  /** the viewport preset: the page lays out at this many CSS px (null = as wide as the body) */
  pageWidth: PageWidth | null
}

/** The owner window's own page, unless the window is going away. */
const appPage = (t: { win: BrowserWindow }): WebContents | null => (t.win.isDestroyed() || t.win.webContents.isDestroyed() ? null : t.win.webContents)

const resolveUrl = (to: string, base: string): string | null => {
  try {
    return new URL(to, base).href
  } catch {
    return null
  }
}

const FOCUS_CHECK_MS = 60

/**
 * Web tiles: one WebContentsView per tile over the owner window, in its own in-memory session with every permission denied,
 * downloads cancelled, new windows denied, dialogs disabled and navigation limited to http, https and about:blank. No preload, no
 * Node, no app protocol in that session. Nothing of a page reaches a log; only its cleaned title and its origin + path leave.
 * No picture of the page is taken: capturePage on a view stalled the whole window's compositor now and then (the app froze), so
 * the static mirror shown while the page is hidden is its title and address.
 */
export class WebTileManager {
  private tiles = new Map<string, Tile>()
  private ses: Session | null = null
  /** the storage of the last pages being wiped (when the last tile closes): a new page loads only after it */
  private cleared: Promise<void> = Promise.resolve()

  constructor(
    private hooks: TileHooks,
    private newId: () => string,
  ) {}

  private session(): Session {
    if (this.ses) return this.ses
    const s = session.fromPartition(TILE_PARTITION)
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    s.setPermissionCheckHandler(() => false)
    s.setDevicePermissionHandler(() => false)
    s.on('select-hid-device', (e, _d, cb) => (e.preventDefault(), cb(null)))
    s.on('select-serial-port', (e, _l, _wc, cb) => (e.preventDefault(), cb('')))
    s.on('select-usb-device', (e, _d, cb) => (e.preventDefault(), cb()))
    s.on('will-download', (e) => e.preventDefault()) // cancels it
    // Chromium refuses a redirect to file: and the like by showing an empty error page at the redirecting address; answered as
    // "204 No Content" instead, the navigation ends and the page stays where it was
    s.webRequest.onHeadersReceived((d, cb) => {
      const headers = d.responseHeaders ?? {}
      const key = d.statusCode >= 300 && d.statusCode < 400 ? Object.keys(headers).find((k) => k.toLowerCase() === 'location') : undefined
      const to = key ? resolveUrl(headers[key]?.[0] ?? '', d.url) : null
      if (!key || (to !== null && mayNavigate(to, d.resourceType !== 'subFrame'))) return cb({})
      cb({ responseHeaders: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== key)), statusLine: 'HTTP/1.1 204 No Content' })
    })
    this.ses = s
    return s
  }

  count(ownerId: number): number {
    return [...this.tiles.values()].filter((t) => t.ownerId === ownerId).length
  }

  owns(ownerId: number, id: string): boolean {
    return this.tiles.get(id)?.ownerId === ownerId
  }

  ids(ownerId: number): string[] {
    return [...this.tiles.values()].filter((t) => t.ownerId === ownerId).map((t) => t.id)
  }

  /** What is saved of each tile of the window: where it belongs and the address it is at (an allowed one). */
  list(ownerId: number): { id: string; workspaceId: string; url: string; pageWidth: PageWidth | null }[] {
    return [...this.tiles.values()].filter((t) => t.ownerId === ownerId).map(({ id, workspaceId, url, pageWidth }) => ({ id, workspaceId, url, pageWidth }))
  }

  /** `url` must already be normalized (normalizeAddress); it is checked again here. */
  create(ownerId: number, win: BrowserWindow, workspaceId: string, url: string, pageWidth: PageWidth | null = null): TileState {
    if (!isAllowedWebUrl(url)) throw new WebTileError('Only http and https addresses are allowed')
    if (this.count(ownerId) >= WEBTILES_MAX) throw new WebTileError(`Web tile limit reached (${WEBTILES_MAX})`)
    this.session() // hardened before the first page of the partition exists
    const view = new WebContentsView({
      webPreferences: {
        partition: TILE_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false,
        disableDialogs: true, // alert, confirm and prompt return at once: nothing of a page can block the app
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    })
    const wc = view.webContents
    tileContents.add(wc)
    const clip = new View()
    const t: Tile = { id: this.newId(), ownerId, workspaceId, win, clip, view, url, title: '', loading: true, error: null, shown: false, keepAppFocus: true, zoom: 1, pageWidth }
    this.tiles.set(t.id, t)
    clip.setVisible(false)
    clip.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    clip.addChildView(view)
    win.contentView.addChildView(clip)
    this.wire(t)
    void this.cleared.then(() => (wc.isDestroyed() ? undefined : wc.loadURL(url))).catch(() => undefined) // a failure arrives as did-fail-load
    this.hooks.changed(ownerId)
    return this.state(t)
  }

  private wire(t: Tile): void {
    const wc = t.view.webContents
    const block = (e: { preventDefault(): void }, url: string, mainFrame: boolean) => {
      if (!mayNavigate(url, mainFrame)) e.preventDefault()
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => block(e, e.url, true))
    wc.on('will-redirect', (e) => block(e, e.url, e.isMainFrame))
    wc.on('will-frame-navigate', (e) => block(e, e.url, e.isMainFrame))
    wc.on('will-attach-webview', (e) => e.preventDefault())
    wc.on('will-prevent-unload', (e) => e.preventDefault()) // beforeunload never holds a tile (or the app) open
    wc.on('select-bluetooth-device', (e, _d, cb) => (e.preventDefault(), cb('')))
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F6') return
      e.preventDefault()
      const app = appPage(t)
      if (!app) return
      t.keepAppFocus = true
      app.focus()
      this.hooks.returned(t.ownerId, t.id)
    })
    // checked a moment later: a click in the page may focus it just before the click itself is reported
    wc.on('focus', () =>
      setTimeout(() => {
        if (t.keepAppFocus && !wc.isDestroyed() && wc.isFocused()) appPage(t)?.focus()
      }, FOCUS_CHECK_MS),
    )
    wc.on('blur', () => (t.keepAppFocus = true)) // to come back, the page is chosen again
    wc.on('before-mouse-event', (_e, m) => {
      if (m.type === 'mouseDown') t.keepAppFocus = false // the user chose the page
    })
    wc.on('page-title-updated', (_e, title) => this.update(t, { title: cleanTitle(title) }))
    wc.on('did-start-loading', () => this.update(t, { loading: true, error: null }))
    wc.on('did-stop-loading', () => this.update(t, { loading: false }))
    // saved on a real navigation only: an app that pushes its history many times a second does not rewrite the board each time
    const at = (url: string, save: boolean) => {
      if (isAllowedWebUrl(url) && url !== t.url) {
        t.url = url
        if (save) this.hooks.changed(t.ownerId)
      }
      this.push(t)
    }
    wc.on('did-navigate', (_e, url) => {
      wc.setZoomFactor(t.zoom) // the zoom of a new origin starts over
      at(url, true)
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && at(url, false))
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.update(t, { error: 'Could not load the page', loading: false }) // -3: aborted (a newer navigation)
    })
    wc.on('render-process-gone', (_e, d) => {
      const reason = goneReason(d.reason)
      recordFailure({ kind: 'gone', reason, exitCode: exitCodeOf(d) })
      this.update(t, { error: goneText(reason), loading: false })
    })
    wc.on('unresponsive', () => {
      recordFailure({ kind: 'unresponsive', reason: 'other', exitCode: null })
      if (t.error === null) this.update(t, { error: NOT_RESPONDING })
    })
    wc.on('responsive', () => {
      if (t.error === NOT_RESPONDING) this.update(t, { error: null })
    })
    wc.once('destroyed', () => this.forget(t))
  }

  private update(t: Tile, patch: Partial<Pick<Tile, 'title' | 'loading' | 'error'>>): void {
    Object.assign(t, patch)
    this.push(t)
  }

  private history(t: Tile): { canGoBack: boolean; canGoForward: boolean } {
    const h = t.view.webContents.isDestroyed() ? null : t.view.webContents.navigationHistory
    return { canGoBack: h?.canGoBack() ?? false, canGoForward: h?.canGoForward() ?? false }
  }

  private state(t: Tile): TileState {
    return { id: t.id, title: t.title, address: shownAddress(t.url), loading: t.loading, error: t.error, ...this.history(t) }
  }

  private push(t: Tile): void {
    if (this.tiles.get(t.id) === t) this.hooks.state(t.ownerId, this.state(t))
  }

  private own(ownerId: number, id: string): Tile {
    const t = this.tiles.get(id)
    if (!t || t.ownerId !== ownerId) throw new WebTileError('Unknown web tile')
    return t
  }

  navigate(ownerId: number, id: string, url: string): void {
    const t = this.own(ownerId, id)
    if (!isAllowedWebUrl(url)) throw new WebTileError('Only http and https addresses are allowed')
    this.update(t, { error: null })
    void t.view.webContents.loadURL(url).catch(() => undefined)
  }

  reload(ownerId: number, id: string): void {
    const t = this.own(ownerId, id)
    this.update(t, { error: null })
    t.view.webContents.reload()
  }

  /** A step in the page's history. Electron emits no will-navigate for history steps, so the target entry is checked here first. */
  back(ownerId: number, id: string): void {
    this.step(this.own(ownerId, id), -1)
  }

  forward(ownerId: number, id: string): void {
    this.step(this.own(ownerId, id), 1)
  }

  private step(t: Tile, by: -1 | 1): void {
    const h = t.view.webContents.navigationHistory
    if (by < 0 ? !h.canGoBack() : !h.canGoForward()) return
    if (!mayNavigate(h.getEntryAtIndex(h.getActiveIndex() + by)?.url ?? '', true)) return // refused: the page stays where it was
    if (by < 0) h.goBack()
    else h.goForward()
  }

  /** Into the page, by keyboard; only while it is shown (keys never go to a page the user cannot see). */
  focus(ownerId: number, id: string): void {
    const t = this.own(ownerId, id)
    if (!t.shown) throw new WebTileError('The page is covered or off screen; bring it into view first')
    t.keepAppFocus = false
    t.view.webContents.focus()
  }

  /**
   * Where the tile's body and the board's free area are in the window (CSS px of the app page) and the board zoom. Shown only when
   * asked and enough of the body is inside both the free area and the window, clipped to that part; the renderer decides the rest
   * (nothing over it, workspace active).
   */
  place(ownerId: number, p: Placement): void {
    const t = this.own(ownerId, p.id)
    const app = appPage(t)
    if (!app) return
    const [width = 0, height = 0] = t.win.getContentSize()
    const { clip, page, show: fits, zoom } = viewBounds(p, p.free, app.getZoomFactor(), { width, height }, p.pageWidth)
    if (p.pageWidth !== t.pageWidth) {
      t.pageWidth = p.pageWidth
      this.hooks.changed(t.ownerId) // the preset is saved with the board
    }
    const show = p.visible && fits
    if (show) {
      t.clip.setBounds(clip)
      t.view.setBounds(page) // the whole body, so the page keeps its size (no reflow) as the clip changes
      const z = Math.min(PAGE_ZOOM.max, Math.max(PAGE_ZOOM.min, zoom ?? p.zoom))
      if (z !== t.zoom) {
        t.zoom = z
        t.view.webContents.setZoomFactor(z)
      }
    }
    if (show === t.shown) return
    if (!show && t.view.webContents.isFocused()) appPage(t)?.focus() // keys never go on to a page that is hidden
    t.shown = show
    t.clip.setVisible(show)
  }

  close(ownerId: number, id: string): void {
    this.destroy(this.own(ownerId, id))
  }

  closeOwned(ownerId: number): void {
    for (const t of [...this.tiles.values()]) if (t.ownerId === ownerId) this.destroy(t)
  }

  /**
   * The window's page reloads or its renderer died: its tile nodes are gone, so their views are hidden at once and closed, the focus
   * back in the window. Nothing is saved for it (the saved board keeps its tiles until the next real change).
   */
  dropOwned(ownerId: number): void {
    for (const t of [...this.tiles.values()]) {
      if (t.ownerId !== ownerId) continue
      if (!t.view.webContents.isDestroyed() && t.view.webContents.isFocused()) appPage(t)?.focus()
      t.clip.setVisible(false)
      this.destroy(t, false)
    }
  }

  private destroy(t: Tile, save = true): void {
    this.forget(t, save)
    const wc = t.view.webContents
    // the window may be going away itself (its page already destroyed): then it is left alone, only the tile's page is closed
    const app = appPage(t)
    try {
      // a page that has the keyboard hands it back to its window first: closing it must not leave the window without focus
      if (app && !wc.isDestroyed() && wc.isFocused()) app.focus()
      if (app) t.win.contentView.removeChildView(t.clip)
    } finally {
      if (!wc.isDestroyed()) wc.close()
    }
  }

  private forget(t: Tile, save = true): void {
    if (this.tiles.get(t.id) !== t) return
    this.tiles.delete(t.id)
    // no page left: what they stored goes, so nothing of one project's pages shows up in another's
    if (this.tiles.size === 0 && this.ses) this.cleared = this.ses.clearStorageData().catch(() => undefined)
    if (save) this.hooks.changed(t.ownerId)
  }
}

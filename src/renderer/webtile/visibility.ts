// Pure rule for when a web tile's native page may show (it is drawn above the whole app, so it only shows where nothing else can be).

export type Rect = { x: number; y: number; width: number; height: number }
/** The screen margins the app's chrome takes: top bar, the left toolbar, the bottom pills, command bar and footers, and a little air. */
export type Margins = { top: number; right: number; bottom: number; left: number }
export type TileUi = {
  /** the tile's workspace is the one in view */
  activeWorkspace: boolean
  /** a dialog, popover, menu or list of the app is open */
  overlay: boolean
  /** a card is maximized */
  maximized: boolean
  /** a node is being dragged or resized, or a selection box drawn */
  moving: boolean
  /** the selection tool is active (a drawing tool covers the board) */
  selectTool: boolean
  /** another node of the board overlaps the tile */
  overlapped: boolean
}

/** The part of the window the board has to itself. */
export function freeArea(window: { width: number; height: number }, m: Margins): Rect {
  return { x: m.left, y: m.top, width: Math.max(0, window.width - m.left - m.right), height: Math.max(0, window.height - m.top - m.bottom) }
}

/** `inner` lies entirely within `outer` (touching an edge counts as inside). */
export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const MIN_SIDE = 16 // smaller than this the page is not worth showing (and its picture says enough)

/** The native page shows only when the body is wholly inside the free area and nothing is, or could get, over it. */
export function tileVisible(body: Rect, free: Rect, ui: TileUi): boolean {
  const finite = [body.x, body.y, body.width, body.height].every(Number.isFinite)
  return finite && body.width >= MIN_SIDE && body.height >= MIN_SIDE && contains(free, body) && ui.activeWorkspace && !ui.overlay && !ui.maximized && !ui.moving && ui.selectTool && !ui.overlapped
}

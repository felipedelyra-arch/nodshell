// Pure rule for when a web tile's native page may show (it is drawn above the whole app, so it only shows where nothing else can be).
import { intersect, SHOWN_SIDE_MIN, type Box } from '../../shared/webtile'

export type Rect = Box
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

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * The native page shows when enough of the body is inside the free area (main draws only that part) and nothing is, or could get,
 * over it.
 */
export function tileVisible(body: Rect, free: Rect, ui: TileUi): boolean {
  const finite = [body.x, body.y, body.width, body.height].every(Number.isFinite)
  const seen = intersect(body, free)
  return finite && seen.width >= SHOWN_SIDE_MIN && seen.height >= SHOWN_SIDE_MIN && ui.activeWorkspace && !ui.overlay && !ui.maximized && !ui.moving && ui.selectTool && !ui.overlapped
}

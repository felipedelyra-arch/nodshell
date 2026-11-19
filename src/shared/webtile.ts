/** Web tiles (a live web page on the board): limits shared by the renderer, the IPC schemas and main. */
export const WEBTILES_MAX = 4
/** what the user may type (and what is kept of a page's address) */
export const ADDRESS_MAX = 2048
/** what the renderer is shown of a page: its title and its address (origin + path only) */
export const TITLE_MAX = 200
export const ADDRESS_SHOWN_MAX = 300
export const DEFAULT_ADDRESS = 'http://localhost:3000'

/** The widths a tile's page can be laid out at (Mobile, Tablet, Desktop); null = the page is as wide as the tile ("Fit"). */
export const PAGE_WIDTHS = [390, 768, 1440] as const
export type PageWidth = (typeof PAGE_WIDTHS)[number]
/** Anything read back (saved board, IPC) that is not one of the widths is "Fit". */
export const pageWidthOf = (v: unknown): PageWidth | null => PAGE_WIDTHS.find((w) => w === v) ?? null
/** The page zoom main allows. */
export const PAGE_ZOOM = { min: 0.25, max: 5 }

export type Box = { x: number; y: number; width: number; height: number }
/** Below this many px on a side, the visible part of a page is not worth showing. */
export const SHOWN_SIDE_MIN = 16
/** Where two boxes overlap (width or height 0 when they do not). */
export function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
}

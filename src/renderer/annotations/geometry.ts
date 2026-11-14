// Pure annotation geometry (board coordinates): simplifying strokes, bounds, hit testing, moving and resizing. No React, no store.
import { MIN_BOX, STROKE_POINTS_MAX, type Annotation } from '../../shared/annotation'

export type Pt = [number, number]
export type Box = { x: number; y: number; w: number; h: number }
export type Corner = 'nw' | 'ne' | 'sw' | 'se'

const LIMIT = 1_000_000
const clampCoord = (v: number) => Math.min(LIMIT, Math.max(-LIMIT, v))

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Ramer-Douglas-Peucker, iterative (a long stroke must not overflow the call stack). */
function rdp(pts: Pt[], eps: number): Pt[] {
  const n = pts.length
  if (n < 3) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    let far = 0
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i]!, pts[a]!, pts[b]!)
      if (d > far) [far, at] = [d, i]
    }
    if (at >= 0 && far > eps) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return pts.filter((_, i) => keep[i] === 1)
}

/** A finished stroke: simplified (the tolerance grows until it fits `max` points), at least two points so a tap still draws a dot. */
export function simplifyStroke(points: Pt[], max = STROKE_POINTS_MAX, eps = 0.75): Pt[] {
  let out = rdp(points, eps)
  while (out.length > max) {
    eps *= 1.6
    out = rdp(points, eps)
  }
  return out.length === 1 ? [out[0]!, out[0]!] : out
}

export function boundsOf(a: Annotation): Box {
  if (a.kind !== 'stroke') return { x: a.x, y: a.y, w: a.w, h: a.h }
  const xs = a.points.map((p) => p[0])
  const ys = a.points.map((p) => p[1])
  const pad = a.width / 2
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
}

/** The topmost-first test for the eraser: is the board point (x, y) on this annotation, within `tol`? */
export function hits(a: Annotation, x: number, y: number, tol: number): boolean {
  if (a.kind === 'stroke') {
    const reach = a.width / 2 + tol
    const pts = a.points
    return pts.length === 1 ? Math.hypot(x - pts[0]![0], y - pts[0]![1]) <= reach : pts.some((p, i) => i > 0 && distToSegment([x, y], pts[i - 1]!, p) <= reach)
  }
  if (a.kind === 'shape' && a.shape === 'ellipse') {
    const rx = a.w / 2 + tol
    const ry = a.h / 2 + tol
    return ((x - a.x - a.w / 2) / rx) ** 2 + ((y - a.y - a.h / 2) / ry) ** 2 <= 1
  }
  return x >= a.x - tol && x <= a.x + a.w + tol && y >= a.y - tol && y <= a.y + a.h + tol
}

/** The same annotation moved by (dx, dy), staying inside the coordinate range main accepts. */
export function moved(a: Annotation, dx: number, dy: number): Annotation {
  if (a.kind === 'stroke') return { ...a, points: a.points.map(([x, y]): Pt => [clampCoord(x + dx), clampCoord(y + dy)]) }
  return { ...a, x: clampCoord(a.x + dx), y: clampCoord(a.y + dy) }
}

/** A box dragged by one corner; the opposite corner stays. `ratio` (w/h) keeps the proportions. Never smaller than MIN_BOX. */
export function resizedBox(b: Box, corner: Corner, dx: number, dy: number, ratio?: number): Box {
  const west = corner === 'nw' || corner === 'sw'
  const north = corner === 'nw' || corner === 'ne'
  let w = Math.max(MIN_BOX, b.w + (west ? -dx : dx))
  let h = Math.max(MIN_BOX, b.h + (north ? -dy : dy))
  if (ratio) {
    // the larger of the two requested changes decides
    if (w / b.w >= h / b.h) h = Math.max(MIN_BOX, w / ratio)
    else w = Math.max(MIN_BOX, h * ratio)
    if (w / ratio < MIN_BOX) [w, h] = [MIN_BOX * ratio, MIN_BOX]
  }
  return { x: clampCoord(west ? b.x + b.w - w : b.x), y: clampCoord(north ? b.y + b.h - h : b.y), w, h }
}

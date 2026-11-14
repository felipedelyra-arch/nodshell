import { describe, expect, it } from 'vitest'
import { ANNOTATIONS_MAX, ANNOTATION_TEXT_MAX, MIN_BOX, POINTS_TOTAL_MAX, STROKE_POINTS_MAX, annotationList, annotationSchema, workspaceAnnotations, type Annotation } from '../../src/shared/annotation'
import { boundsOf, hits, moved, resizedBox, simplifyStroke, type Pt } from '../../src/renderer/annotations/geometry'
import { staleWorkspaces } from '../../src/main/application/board'
import { channels } from '../../src/shared/ipc/channels'
import { useAnnotations } from '../../src/renderer/annotations/store'

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stroke = (n: number, points: Pt[] = [[0, 0], [10, 10]]): Annotation => ({ id: uid(n), kind: 'stroke', color: '#ff6a2b', width: 3, points })
const shape = (n: number, extra: object = {}): Annotation => ({ id: uid(n), kind: 'shape', shape: 'rect', color: '#ff6a2b', x: 0, y: 0, w: 100, h: 50, ...extra }) as Annotation

describe('simplifyStroke', () => {
  it('keeps the shape of a noisy line within the point ceiling and keeps both ends', () => {
    const pts: Pt[] = Array.from({ length: 6000 }, (_, i) => [i * 0.5, Math.sin(i / 7) * 40 + (i % 3) * 0.2])
    const out = simplifyStroke(pts)
    expect(out.length).toBeLessThanOrEqual(STROKE_POINTS_MAX)
    expect(out.length).toBeGreaterThan(20)
    expect(out[0]).toEqual(pts[0])
    expect(out.at(-1)).toEqual(pts.at(-1))
  })
  it('drops the points of a straight line and turns a tap into a dot', () => {
    expect(simplifyStroke(Array.from({ length: 50 }, (_, i): Pt => [i, i * 2]))).toEqual([[0, 0], [49, 98]])
    expect(simplifyStroke([[5, 5]])).toEqual([[5, 5], [5, 5]])
  })
  it('widens its tolerance until a hard ceiling is met', () => {
    const zig: Pt[] = Array.from({ length: 400 }, (_, i) => [i, i % 2 ? 30 : -30])
    expect(simplifyStroke(zig, 50).length).toBeLessThanOrEqual(50)
  })
})

describe('geometry', () => {
  it('hits strokes near the line, ellipses inside the curve and boxes inside the box', () => {
    const line = stroke(1, [[0, 0], [100, 0]])
    expect(hits(line, 50, 1, 0)).toBe(true)
    expect(hits(line, 50, 20, 4)).toBe(false)
    const ellipse = shape(2, { shape: 'ellipse', w: 100, h: 100 })
    expect(hits(ellipse, 50, 50, 0)).toBe(true)
    expect(hits(ellipse, 2, 2, 0)).toBe(false) // the corner of the box is outside the ellipse
    expect(hits(shape(3), 99, 49, 0)).toBe(true)
    expect(hits(shape(3), 140, 10, 6)).toBe(false)
  })
  it('moves strokes point by point and boxes by their corner, inside the coordinate range', () => {
    expect((moved(stroke(1), 5, -5) as { points: Pt[] }).points).toEqual([[5, -5], [15, 5]])
    expect(moved(shape(2), 10, 10)).toMatchObject({ x: 10, y: 10 })
    expect(moved(shape(2), 5_000_000, 0)).toMatchObject({ x: 1_000_000 })
  })
  it('resizes from a corner, never below the minimum, and can keep the proportions', () => {
    expect(resizedBox({ x: 0, y: 0, w: 100, h: 50 }, 'se', 20, 10)).toEqual({ x: 0, y: 0, w: 120, h: 60 })
    expect(resizedBox({ x: 0, y: 0, w: 100, h: 50 }, 'nw', 30, 10)).toEqual({ x: 30, y: 10, w: 70, h: 40 })
    expect(resizedBox({ x: 0, y: 0, w: 100, h: 50 }, 'se', -500, -500)).toMatchObject({ w: MIN_BOX, h: MIN_BOX })
    const r = resizedBox({ x: 0, y: 0, w: 200, h: 100 }, 'se', 100, 0, 2)
    expect(r.w / r.h).toBeCloseTo(2)
    expect(boundsOf(stroke(1, [[10, 10], [20, 30]]))).toEqual({ x: 8.5, y: 8.5, w: 13, h: 23 })
  })
})

describe('annotation schema', () => {
  it('accepts each kind', () => {
    for (const a of [stroke(1), shape(2), { id: uid(3), kind: 'text', color: '#ffffff', x: 1, y: 2, w: 10, h: 10, text: 'hello <b>x</b>' }, { id: uid(4), kind: 'image', imageId: uid(9), x: 0, y: 0, w: 5, h: 5 }]) expect(annotationSchema.safeParse(a).success).toBe(true)
  })
  it('refuses NaN, Infinity, out-of-range numbers, bad colours and unknown kinds', () => {
    for (const bad of [shape(1, { x: NaN }), shape(1, { w: Infinity }), shape(1, { w: 0 }), shape(1, { x: 2_000_000 }), shape(1, { color: 'red' }), shape(1, { color: 'url(javascript:1)' }), { ...stroke(1), width: 99 }, { ...stroke(1), points: [[0, NaN]] }, { id: uid(1), kind: 'html', body: '<b>' }, { ...shape(1), id: 'not-a-uuid' }]) {
      expect(annotationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
  it('bounds text, points and counts', () => {
    const note = (text: string) => ({ id: uid(1), kind: 'text', color: '#ffffff', x: 0, y: 0, w: 10, h: 10, text })
    expect(annotationSchema.safeParse(note('x'.repeat(ANNOTATION_TEXT_MAX))).success).toBe(true)
    expect(annotationSchema.safeParse(note('x'.repeat(ANNOTATION_TEXT_MAX + 1))).success).toBe(false)
    expect(annotationSchema.safeParse(note('a\0b')).success).toBe(false)
    expect(annotationSchema.safeParse(stroke(1, Array.from({ length: STROKE_POINTS_MAX + 1 }, (): Pt => [0, 0]))).success).toBe(false)
    expect(annotationSchema.safeParse(stroke(1, [])).success).toBe(false)
    const many = Array.from({ length: ANNOTATIONS_MAX + 1 }, (_, i) => shape(i + 1))
    expect(annotationList.safeParse(many.slice(0, ANNOTATIONS_MAX)).success).toBe(true)
    expect(annotationList.safeParse(many).success).toBe(false)
    const heavy = Array.from({ length: POINTS_TOTAL_MAX / STROKE_POINTS_MAX + 1 }, (_, i) => stroke(i + 1, Array.from({ length: STROKE_POINTS_MAX }, (): Pt => [1, 1])))
    expect(annotationList.safeParse(heavy).success).toBe(false)
    expect(annotationList.safeParse([shape(1), shape(1)]).success).toBe(false) // one id twice
  })
  it('the IPC channels take only ids, finite numbers and no paths', () => {
    expect(channels['annotations:save'].in.safeParse({ workspaceId: uid(1), items: [shape(2)] }).success).toBe(true)
    expect(channels['annotations:save'].in.safeParse({ workspaceId: 'x', items: [] }).success).toBe(false)
    expect(workspaceAnnotations.safeParse({ workspaceId: uid(1), items: [shape(2, { x: NaN })] }).success).toBe(false)
    expect('image:release' in channels).toBe(false) // main alone decides when an image file goes
    expect(channels['image:pick'].in.safeParse({ path: '/etc/passwd' }).success).toBe(false) // takes nothing at all
    expect(channels['image:pick'].out.safeParse({ image: { id: uid(1), width: 10, height: 10 } }).success).toBe(true)
    expect(channels['image:pick'].out.safeParse({ image: { id: uid(1), width: 10, height: 10, path: '/x' } }).success).toBe(true) // extra keys are stripped, never passed through
    expect(channels['image:pick'].out.parse({ image: { id: uid(1), width: 10, height: 10, path: '/x' } })).toEqual({ image: { id: uid(1), width: 10, height: 10 } })
  })
})

describe('annotation store ceilings', () => {
  it('refuses the 2001st annotation of a workspace and a stroke over the points budget, but another workspace is not affected', () => {
    const { add } = useAnnotations.getState()
    for (let i = 0; i < ANNOTATIONS_MAX; i++) expect(add('w1', shape(i + 1))).toBe(true)
    expect(add('w1', shape(ANNOTATIONS_MAX + 1))).toBe(false)
    expect(useAnnotations.getState().items['w1']).toHaveLength(ANNOTATIONS_MAX)
    expect(add('w2', shape(1))).toBe(true)
    for (let i = 0; i < POINTS_TOTAL_MAX / STROKE_POINTS_MAX; i++) expect(add('w3', stroke(i + 1, Array.from({ length: STROKE_POINTS_MAX }, (): Pt => [i, i])))).toBe(true)
    expect(add('w3', stroke(999))).toBe(false)
  })
})

describe('staleWorkspaces', () => {
  it('only a workspace the renderer had and no longer lists may be pruned; one it never loaded is never touched', () => {
    expect(staleWorkspaces(new Set(['a', 'b']), ['a'])).toEqual(['b'])
    expect(staleWorkspaces(new Set(), ['fresh-workspace'])).toEqual([]) // nothing was loaded: a save deletes nothing
    expect(staleWorkspaces(new Set(['a']), ['a'])).toEqual([])
  })
})

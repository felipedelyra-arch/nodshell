import { z } from 'zod'

/** Board annotations (strokes, shapes, notes, images): limits shared by the renderer, the IPC schemas and the database reader. */
export const ANNOTATIONS_MAX = 2000
/** points kept per stroke once it is finished (it is simplified down to this) */
export const STROKE_POINTS_MAX = 1000
/** points collected while the pen is down; the stroke ends by itself at this many */
export const STROKE_RAW_MAX = 8000
/** all strokes of one workspace together (bounds one save) */
export const POINTS_TOTAL_MAX = 100_000
export const ANNOTATION_TEXT_MAX = 2000
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_DIM_MAX = 8192
/** picked from the toolbar; the first is the brand orange (all of them read well on #0a0a0b) */
export const ANNOTATION_COLORS = ['#ff6a2b', '#ffd23d', '#3ddc84', '#4cc9f0', '#a78bfa', '#ff6b9d', '#e4e4e7', '#ff4d4f'] as const
export const DEFAULT_COLOR = ANNOTATION_COLORS[0]
export const MIN_BOX = 12

const id = z.uuid()
const coord = z.number().finite().min(-1_000_000).max(1_000_000)
const extent = z.number().finite().min(1).max(100_000)
const color = z.string().regex(/^#[0-9a-f]{6}$/i)
const box = { x: coord, y: coord, w: extent, h: extent }

export const annotationSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('stroke'), color, width: z.number().finite().min(1).max(32), points: z.array(z.tuple([coord, coord])).min(1).max(STROKE_POINTS_MAX) }),
  z.object({ id, kind: z.literal('shape'), shape: z.enum(['rect', 'ellipse']), color, ...box }),
  // plain text only: it is rendered as a text node, never as HTML
  z.object({ id, kind: z.literal('text'), color, ...box, text: z.string().max(ANNOTATION_TEXT_MAX).refine((t) => !t.includes('\0')) }),
  z.object({ id, kind: z.literal('image'), imageId: id, ...box }),
])
export type Annotation = z.infer<typeof annotationSchema>

export const pointsOf = (items: Annotation[]) => items.reduce((n, a) => n + (a.kind === 'stroke' ? a.points.length : 0), 0)
/** one workspace's annotations: bounded in count and in total points, ids unique */
export const annotationList = z
  .array(annotationSchema)
  .max(ANNOTATIONS_MAX)
  .refine((l) => pointsOf(l) <= POINTS_TOTAL_MAX && new Set(l.map((a) => a.id)).size === l.length)
export const workspaceAnnotations = z.object({ workspaceId: id, items: annotationList })
export const imageInfo = z.object({ id, width: z.number().int().min(1).max(IMAGE_DIM_MAX), height: z.number().int().min(1).max(IMAGE_DIM_MAX) })

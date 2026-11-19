// Pure: what an edge's moving dots show (direction, speed, tone) and the keyframes that move them along its path.
import type { AgentState } from '../graph'

export type EdgeActivity = { direction: 'toOrchestrator' | 'toGroup' | 'forward'; speed: 'fast' | 'slow' | 'stopped'; tone: 'normal' | 'error' | 'paused' }

export type EdgeContext = {
  /** the edge ends at an Orchestrator (its source is a group or an agent of the board) */
  orchestrator: boolean
  /** agent states at each end: a group's members, an agent, an Orchestrator's own agent */
  source: AgentState[]
  target: AgentState[]
  /** a reply was just passed on through this edge */
  firing: boolean
  /** the Orchestrator has a running delegation for the source end (the group or one of its agents) */
  delegating: boolean
  /** the latest delegation for the source end failed */
  taskFailed: boolean
  /** every flow paused (Pause all or a guard); the processes stopped by Pause all */
  flowsPaused: boolean
  processesPaused: boolean
}

export function edgeActivity(edge: { paused: string | null; note: string | null }, c: EdgeContext): EdgeActivity {
  const stopped = edge.paused !== null || c.flowsPaused || c.processesPaused
  const delegating = c.orchestrator && c.delegating
  const direction = delegating ? 'toGroup' : c.orchestrator && c.firing ? 'toOrchestrator' : 'forward'
  const busy = c.source.includes('working') || c.firing || delegating
  const error = c.source.includes('error') || c.target.includes('error') || edge.note !== null || c.taskFailed
  return { direction, speed: stopped ? 'stopped' : busy ? 'fast' : 'slow', tone: stopped ? 'paused' : error ? 'error' : 'normal' }
}

/** The state in words, for the edge's button (never colour alone): "delegating, running", "resting", "paused", "error, resting". */
export function activityWords(a: EdgeActivity): string {
  if (a.tone === 'paused') return 'paused'
  const what = a.direction === 'toGroup' ? 'delegating' : a.direction === 'toOrchestrator' ? 'passing a reply' : null
  return [what, a.tone === 'error' ? 'error' : null, a.speed === 'fast' ? 'running' : 'resting'].filter(Boolean).join(', ')
}

type Point = { x: number; y: number }

/**
 * Keyframes for a dot running along sampled path points (source -> target, or back with `reverse`), as translations inside the
 * points' bounding box; the dot fades in and out at the ends so the wrap-around does not jump.
 */
export function runnerPath(points: Point[], reverse: boolean): { box: { x: number; y: number; w: number; h: number }; frames: Keyframe[] } {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  const run = reverse ? [...points].reverse() : points
  const last = run.length - 1
  const frames = run.map((p, i): Keyframe => ({ transform: `translate(${(p.x - box.x).toFixed(1)}px, ${(p.y - box.y).toFixed(1)}px)`, opacity: i === 0 || i === last ? 0 : 1, offset: last > 0 ? i / last : 0 }))
  return { box, frames }
}

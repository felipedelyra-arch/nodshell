// Zod-free agent rules shared by main (domain + IPC schemas) and the renderer (inline validation).
export const ROLE_RE = /^[a-z][a-z0-9-]{0,23}$/
export const MODEL_CHOICES = ['opus', 'sonnet', 'haiku'] as const
export type ModelChoice = (typeof MODEL_CHOICES)[number]
export const PROMPT_MAX = 20_000
/** Live processes (agents and consoles) at once: two squads (18) plus two consoles. The single source for every limit. */
export const MAX_LIVE = 20
/** The user may set the limit from 1 up to this hard ceiling (stored in settings; enforced in main). Schemas use the ceiling, never the current value. */
export const LIVE_LIMIT_MIN = 1
export const LIVE_HARD_MAX = 40
/** Boards (workspaces) per project. */
export const WORKSPACES_MAX = 8
/** The four groups of a squad, in creation order; each has SQUAD_GROUP_SIZE agents, plus one orchestrator. */
export const SQUAD_ROLES = ['frontend', 'backend', 'tester', 'reviewer'] as const
export type SquadRole = (typeof SQUAD_ROLES)[number]
export const SQUAD_GROUP_SIZE = 2
export const SQUAD_SIZE = 1 + SQUAD_ROLES.length * SQUAD_GROUP_SIZE
/** The spec's four states plus the process-level `starting` (before the session is ready) and `exited` (clean exit). */
export const AGENT_STATES = ['starting', 'idle', 'working', 'waiting', 'error', 'exited'] as const
export type AgentStateName = (typeof AGENT_STATES)[number]
export const LAST_MESSAGE_MAX = 100_000
/** Short display and routing name: "Zoe", or "Zoe2" once the list is exhausted. Never a path, branch or argv value. */
export const AGENT_NAME_RE = /^[A-Z][a-z]{1,4}(?:[2-9]|[1-9]\d{1,2})?$/
/** What the user reads for each state; "paused" is shown over any live state while Pause all holds the processes. */
export const STATUS_LABEL = { starting: 'starting', working: 'running', idle: 'resting', waiting: 'needs you', error: 'error', exited: 'exited', paused: 'paused' } as const
/** The status pill: orange only while the process is actively working (a console that runs counts as running); every other state is muted. */
export function statusPill(s: AgentStateName | 'running' | 'paused'): { label: string; active: boolean } {
  return s === 'running' ? { label: 'running', active: true } : { label: STATUS_LABEL[s], active: s === 'working' }
}

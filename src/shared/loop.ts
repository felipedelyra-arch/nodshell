// Zod-free loop rules shared by main (domain + IPC schemas) and the renderer (inline limits).
export const LOOP_STATES = ['active', 'paused', 'done'] as const
export const LOOP_TRIGGERS = ['schedule', 'idle', 'output'] as const
/** schedule: every N seconds */
export const SCHEDULE_MIN_SEC = 60
export const SCHEDULE_MAX_SEC = 86_400
/** idle: the agent resting for N seconds in a row */
export const IDLE_MIN_SEC = 30
export const IDLE_MAX_SEC = 3600
/** output: a text appears in a terminal's new output; at least this long between two firings */
export const OUTPUT_TEXT_MAX = 200
export const OUTPUT_COOLDOWN_SEC = 30
export const GOAL_MAX = 200
export const LOOP_RUNS_MAX = 100
export const LOOP_RUNS_DEFAULT = 20
export const GOAL_REACHED = 'Goal reached'
export const PAUSED_ON_REOPEN = 'Paused on reopen'

// Zod-free flow rules shared by main (domain + IPC schemas) and the renderer (inline limits).
export const TEMPLATE_MAX = 2000
export const CONDITION_MAX = 200
/** `{message}`, `{name}`, `{group}` and `{role}` are those of the agent whose turn ended. */
export const DEFAULT_TEMPLATE = 'From {name} ({role}):\n{message}'
/** report_status text, shown in the agent's details */
export const REPORT_MAX = 200
/** send_message text; room is left for the sender line */
export const MESSAGE_MAX = 10_000
/** Edges per window */
export const EDGES_MAX = 200
/** Short, path-free reasons shown to the user (edge state, toasts). */
export const REASON_MAX = 200
/** An Orchestrator's delegations: their states, the tasks kept per squad, a title's length and how many the renderer gets listed. */
export const TASK_STATUSES = ['queued', 'running', 'done', 'failed'] as const
export const TASKS_MAX = 200
export const TASK_TITLE_MAX = 120
export const TASKS_RECENT = 8

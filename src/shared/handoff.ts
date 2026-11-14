// Zod-free handoff rules shared by main (domain + IPC schemas) and the renderer (the dialog's counter).
import { PROMPT_MAX } from './agent'

export const HANDOFF_STATES = ['summarizing', 'ready'] as const
/** The briefing's ceiling: the whole prompt (header + blank line + briefing) stays within PROMPT_MAX (a header is far below 200). */
export const BRIEFING_MAX = PROMPT_MAX - 200

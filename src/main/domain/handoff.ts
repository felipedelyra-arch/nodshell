// Pure handoff rules: no Electron, no processes, no timers.
import { PROMPT_MAX } from '../../shared/agent'
import { BRIEFING_MAX } from '../../shared/handoff'
import { AgentError } from './agent'
import { cleanLine, cleanText } from './task'

/** The fixed prompt that asks the outgoing agent for its briefing; sent as the user's own prompt (the user clicked Hand off). */
export const BRIEFING_REQUEST =
  'Another agent is taking over your work. Write a handoff briefing for them with: what you did, the current state, the files and the branch involved, the next steps, and anything pending or unresolved. Reply with the briefing only, no preamble.'

/** Without the summary this long after asking, the handoff is cancelled. */
export const SUMMARY_TIMEOUT_MS = 5 * 60_000

export type HandoffSource = { name: string; role: string; branch: string }

export const handoffHeader = (from: HandoffSource): string => cleanLine(`Handoff from ${from.name} (${from.role}${from.branch ? `, branch ${from.branch}` : ''})`)

/** The agent's reply as the dialog shows it: cleaned like any message (no control or format characters), trimmed, cut to BRIEFING_MAX. */
export const briefingOf = (message: string): string => cleanText(message).trim().slice(0, BRIEFING_MAX)

/** The ONE prompt the next agent gets: header, blank line, briefing (cleaned). Throws an AgentError saying what is wrong. */
export function handoffPrompt(from: HandoffSource, briefing: string): string {
  const body = cleanText(briefing).trim()
  if (!body) throw new AgentError('The briefing is empty')
  if (body.length > BRIEFING_MAX) throw new AgentError(`The briefing is longer than ${BRIEFING_MAX} characters`)
  const text = `${handoffHeader(from)}\n\n${body}`
  if (text.length > PROMPT_MAX) throw new AgentError(`The handoff is longer than ${PROMPT_MAX} characters`)
  return text
}

// Pure loop rules: no Electron, no processes, no timers.
import { PROMPT_MAX } from '../../shared/agent'
import { GOAL_MAX, IDLE_MAX_SEC, IDLE_MIN_SEC, LOOP_RUNS_MAX, OUTPUT_TEXT_MAX, SCHEDULE_MAX_SEC, SCHEDULE_MIN_SEC, type LOOP_STATES } from '../../shared/loop'
import { AgentError } from './agent'
import { cleanLine, cleanText } from './task'

export type LoopTrigger = { kind: 'schedule'; everySec: number } | { kind: 'idle'; afterSec: number } | { kind: 'output'; terminalId: string; text: string }
export type LoopState = (typeof LOOP_STATES)[number]
/** What the user sets: the prompt repeated in one agent, when, until what ('' = no goal), at most how many times. */
export type LoopInput = { prompt: string; trigger: LoopTrigger; goal: string; maxRuns: number }
/** At most one per agent (never a console). `reason`: why it is paused or done; null while active. */
export type Loop = LoopInput & { id: string; ownerId: number; workspaceId: string; agentId: string; runs: number; state: LoopState; reason: string | null }
/** As saved with the board: runs and state are not kept (a reopened loop comes back paused, from zero). */
export type SavedLoop = LoopInput & { id: string; workspaceId: string; agentId: string }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const whole = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi

/**
 * The input as the loop keeps it: prompt cleaned like a task's text (no control or format characters but \n and \t), goal and
 * watched text cleaned to one line, every number within its bounds. Throws an AgentError saying what is wrong.
 */
export function normalizeLoop(input: LoopInput): LoopInput {
  const prompt = cleanText(input.prompt)
  if (!prompt.trim()) throw new AgentError('The loop needs a prompt')
  if (prompt.length > PROMPT_MAX) throw new AgentError('The loop prompt is too long')
  const goal = cleanLine(input.goal).trim()
  if (goal.length > GOAL_MAX) throw new AgentError(`The goal is longer than ${GOAL_MAX} characters`)
  if (!whole(input.maxRuns, 1, LOOP_RUNS_MAX)) throw new AgentError(`Max runs must be between 1 and ${LOOP_RUNS_MAX}`)
  const t = input.trigger
  let trigger: LoopTrigger
  if (t.kind === 'schedule') {
    if (!whole(t.everySec, SCHEDULE_MIN_SEC, SCHEDULE_MAX_SEC)) throw new AgentError(`Schedule must be between ${SCHEDULE_MIN_SEC} and ${SCHEDULE_MAX_SEC} seconds`)
    trigger = { kind: 'schedule', everySec: t.everySec }
  } else if (t.kind === 'idle') {
    if (!whole(t.afterSec, IDLE_MIN_SEC, IDLE_MAX_SEC)) throw new AgentError(`Idle time must be between ${IDLE_MIN_SEC} and ${IDLE_MAX_SEC} seconds`)
    trigger = { kind: 'idle', afterSec: t.afterSec }
  } else if (t.kind === 'output') {
    const text = cleanLine(t.text)
    if (!text.trim()) throw new AgentError('Say which text to watch for')
    if (text.length > OUTPUT_TEXT_MAX) throw new AgentError(`The watched text is longer than ${OUTPUT_TEXT_MAX} characters`)
    if (!UUID_RE.test(t.terminalId)) throw new AgentError('Unknown terminal')
    trigger = { kind: 'output', terminalId: t.terminalId, text }
  } else throw new AgentError('Unknown trigger')
  return { prompt, trigger, goal, maxRuns: input.maxRuns }
}

/** The goal is met when the reply contains it (case-insensitive substring, never a pattern); no goal is never met. */
export const goalReached = (message: string, goal: string): boolean => goal !== '' && message.toLowerCase().includes(goal.toLowerCase())

/* eslint-disable no-control-regex -- stripping terminal control sequences is the point */
/** An escape sequence cut at the end of a chunk; kept for the next one. */
const PARTIAL_ESC = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[P^_][^\x1b]*|[ -/]*)$/
const CARRY_MAX = 4096

/** Terminal output as text: ANSI/OSC/control sequences out (cursor-forward as a space), line breaks as \n. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[\d*C/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b[P^_][^\x1b]*(?:\x1b\\)?/g, '') // DCS, PM, APC
    .replace(/\x1b[ -/]*[0-~]?/g, '') // any other escape
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}
/* eslint-enable no-control-regex */

/**
 * Watches a terminal's NEW output for a text (case-insensitive substring): a text cut between two chunks is still found (a tail of
 * the last length-1 characters is kept, and an escape sequence cut at the end waits for its rest), and the same stretch never
 * matches twice (a match consumes what it saw).
 */
export class OutputMatcher {
  private tail = ''
  private carry = ''
  private needle: string
  constructor(text: string) {
    this.needle = text.toLowerCase()
  }

  feed(chunk: string): boolean {
    let raw = this.carry + chunk
    const cut = PARTIAL_ESC.exec(raw)
    this.carry = cut && raw.length - cut.index <= CARRY_MAX ? raw.slice(cut.index) : ''
    if (cut) raw = raw.slice(0, cut.index)
    const hay = this.tail + stripAnsi(raw)
    const hit = hay.toLowerCase().includes(this.needle)
    const keep = this.needle.length - 1
    this.tail = hit || keep === 0 ? '' : hay.slice(-keep)
    return hit
  }
}

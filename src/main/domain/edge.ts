// Pure flow rules: no Electron, no processes.
import { PROMPT_MAX } from '../../shared/agent'

/** Where a flow starts: an agent's turn ending, or that of any member of a group. */
export type SourceEndpoint = { kind: 'agent' | 'group'; id: string }
/** Where it is injected: one agent, every member of a group, or a squad's Orchestrator. */
export type TargetEndpoint = { kind: 'agent' | 'group' | 'squad'; id: string }

export type Edge = {
  id: string
  ownerId: number
  workspaceId: string
  source: SourceEndpoint
  target: TargetEndpoint
  template: string
  /** inject only when the message contains this text (case-insensitive substring); '' = always */
  condition: string
  /** null = active; else why it is paused (by the user or by a guard) */
  paused: string | null
  /** why the last firing did not reach every target, if it did not */
  note: string | null
}

export const MAX_HOPS = 6
/** the same edge firing this many times in one chain is a loop */
export const LOOP_FIRES = 3
export const BURST_MAX = 20
export const BURST_WINDOW_MS = 60_000

export const sameEndpoint = (a: { kind: string; id: string }, b: { kind: string; id: string }): boolean => a.kind === b.kind && a.id === b.id

export function matchesCondition(message: string, condition: string): boolean {
  return !condition || message.toLowerCase().includes(condition.toLowerCase())
}

export type TemplateValues = { message: string; name: string; group: string; role: string }

/**
 * Fills the template in one pass (a placeholder inside the message is never expanded). The result stays within PROMPT_MAX:
 * a long message is cut and says so.
 */
export function renderTemplate(template: string, v: TemplateValues, max = PROMPT_MAX): string {
  const fill = (message: string) => template.replace(/\{(message|name|group|role)\}/g, (_m, k: keyof TemplateValues) => (k === 'message' ? message : v[k]))
  const uses = (template.match(/\{message\}/g) ?? []).length
  const full = fill(v.message)
  if (uses === 0 || full.length <= max) return full.slice(0, max)
  const note = `\n[message truncated, it had ${v.message.length} characters]`
  const room = Math.max(0, Math.floor((max - fill('').length) / uses) - note.length)
  return fill(v.message.slice(0, room) + note).slice(0, max)
}

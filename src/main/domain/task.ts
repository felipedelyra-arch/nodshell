// Pure domain: no Electron, no processes.
import { TASK_TITLE_MAX, type TASK_STATUSES } from '../../shared/flow'

export type TaskStatus = (typeof TASK_STATUSES)[number]
/** Who a task went to: one agent, or a group (by name, as the Orchestrator addressed it). */
export type Assignee = { kind: 'agent' | 'group'; id: string; name: string }
/** One recipient's progress; 'new' until the delivery queue took (or refused) its message. */
export type RecipientState = 'new' | TaskStatus

/** One delegation of an Orchestrator to an agent or group of its own squad. */
export type Task = { id: string; ownerId: number; squadId: string; title: string; assignee: Assignee; status: TaskStatus; createdAt: number; recipients: Map<string, RecipientState> }

// every line break a text renderer may honour, unified to \n first
const BREAKS = /\r\n?|[\u0085\u2028\u2029]/g
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// invisible format characters (zero-width, BOM, soft hyphen, bidi overrides and isolates) could make a dialog read differently
const FORMAT = /\p{Cf}/gu

/** Line breaks -> \n; drops every control character but \n and \t, and every format character. For text an agent wrote that a person reads. */
export const cleanText = (text: string): string => text.replace(BREAKS, '\n').replace(CONTROLS, '').replace(FORMAT, '')

/** One line: cleanText, with line breaks and tabs as spaces. */
export const cleanLine = (text: string): string => cleanText(text).replace(/[\n\t]/g, ' ')

/** The first line with any text, without control characters, cut to TASK_TITLE_MAX. */
export function taskTitle(text: string): string {
  const line = cleanText(text).split('\n').map((l) => l.replace(/\t/g, ' ').trim()).find(Boolean) ?? ''
  return line.length > TASK_TITLE_MAX ? `${line.slice(0, TASK_TITLE_MAX - 1)}…` : line || 'Untitled'
}

/** The first `lines` non-empty lines, each cut to `width`, for a confirmation dialog (plain text, never markup). */
export function previewText(text: string, lines = 6, width = 160): string {
  const all = cleanText(text).split('\n').map((l) => l.replace(/\t/g, ' ').trimEnd()).filter((l) => l.trim())
  const shown = all.slice(0, lines).map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l))
  return all.length > lines ? [...shown, `… (${all.length - lines} more lines)`].join('\n') : shown.join('\n')
}

/**
 * A task from its recipients: queued while none has received it; done or failed once none is waiting or working (done when at
 * least one finished, failed when every one failed); running otherwise.
 */
export function taskStatus(states: Iterable<RecipientState>): TaskStatus {
  const all = [...states]
  if (all.every((s) => s === 'done' || s === 'failed')) return all.includes('done') ? 'done' : 'failed'
  return all.every((s) => s === 'new' || s === 'queued') ? 'queued' : 'running'
}

export const isFinished = (s: RecipientState): boolean => s === 'done' || s === 'failed'

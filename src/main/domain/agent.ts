// Pure domain rules: no Electron, no fs, no child processes.
import { AGENT_NAME_RE, ROLE_RE } from '../../shared/agent'
import type { AgentState } from './adapter'

export type Worktree = {
  repoRoot: string
  path: string
  branch: string
  /** commit the branch was created from; "work" means commits beyond it */
  base: string
}

export type Agent = {
  id: string // the PTY id
  ownerId: number
  adapterId: string
  role: string
  name: string // short display name (Zoe); the branch and worktree keep <role>-<n>
  model: string | undefined
  /** Claude session id; follows the CLI when it starts a new session (e.g. /clear) */
  sessionId: string
  worktree: Worktree
  state: AgentState
  /** no hook event ever arrived while starting: the state cannot be trusted, prompts are allowed with a warning */
  statusUnavailable: boolean
  /** reported by the agent's own hooks; validated again before every read */
  transcriptPath?: string
  /** the renderer's board it belongs to (agents only reach each other inside one) */
  workspaceId?: string
  /** its own status line (MCP report_status) */
  report?: string
  /** what it was started from, kept so it can be relaunched the same way */
  presetId?: string
  systemPrompt?: string
}

export type RemovalOutcome = 'removed' | 'archived' | 'kept'

/** A live process is only stopped after the user confirms; one that already exited closes without asking. */
export const needsCloseConfirm = (state: AgentState): boolean => state !== 'exited' && state !== 'error'

/** The workspace repository: real path of a git top level, held only in main. */
/** `plain`: no git (or no commit yet), so agents share the folder instead of getting a worktree each; `branch` is then only a label. */
export type Repo = { root: string; name: string; branch: string; plain?: true }

/** Asked only when a worktree is dirty; anything but 'discard' keeps everything. */
export type ConfirmDiscard = (wt: Worktree, commits: number) => Promise<'keep' | 'discard'>

/** An error whose message is short, has no paths and is safe to show in the UI. */
export class AgentError extends Error {}

/** A prompt was pasted but its Enter withheld (the agent stopped being ready meanwhile): the text sits unsent in its input. */
export class HeldInput extends AgentError {}

export function isValidRole(role: string): boolean {
  return ROLE_RE.test(role)
}

export function agentName(role: string, n: number): string {
  if (!isValidRole(role) || !Number.isSafeInteger(n) || n < 1) throw new Error('Invalid agent name')
  return `${role}-${n}`
}

export function branchName(role: string, n: number): string {
  return `agent/${agentName(role, n)}`
}

/** The n of `<role>-<n>` (or `agent/<role>-<n>`), or undefined when `name` belongs to another role. */
export function slotOf(name: string, role: string): number | undefined {
  const m = /^(?:agent\/)?(.+)-([1-9]\d{0,8})$/.exec(name)
  return m && m[1] === role ? Number(m[2]) : undefined
}

export function lowestFreeN(taken: Iterable<number>): number {
  const used = new Set(taken)
  let n = 1
  while (used.has(n)) n++
  return n
}

const NAMES = (
  'Zoe Leo Pip Ada Bo Cy Dex Eli Fay Gus Hal Ivy Jax Kai Lia Max Nia Oz Pia Quin Rex Sam Tia Uma Val Wes Xia Yan Zed Amy ' +
  'Ben Cleo Dan Eve Finn Gia Hugo Iris Jo Kit Lou Mia Ned Opal Pax Ray Sky Tom Uri Vic Wyn Zack'
).split(' ')

/** A free short name for a live agent (case-insensitive); once the list is exhausted a number is appended (Zoe2). */
export function pickAgentName(taken: Iterable<string>, rng: () => number = Math.random): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()))
  if (free.length) return free[Math.floor(rng() * free.length)]!
  const base = NAMES[Math.floor(rng() * NAMES.length)]!
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name)
}

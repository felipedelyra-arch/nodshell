// Port implemented by every coding-agent CLI (Claude, Codex, plain shells). The domain never names a concrete agent.
import type { AGENT_STATES } from '../../shared/agent'

export type SpawnOptions = {
  cwd: string
  role: string
  model?: string
  systemPrompt?: string
  mcpConfig?: string
  resumeId?: string
  sessionId: string
  /** status hooks: a settings file for the CLI and the variables its hook relay needs (added after the env filter) */
  hooks?: { settingsPath: string; env: Record<string, string> }
}

/** argv form only: never a shell string */
export type SpawnCommand = { cmd: string; args: string[]; env: Record<string, string> }

export type AgentState = (typeof AGENT_STATES)[number]

/** What adapters may see of a PTY: write, and whether it is still alive. `key` identifies it for serialization. */
export type PromptPty = { key: string; write(data: string): void; alive(): boolean }

/** A validated lifecycle event reported by the agent CLI itself (Claude Code hooks). Never carries prompt or reply text. */
export type HookSignal = { type: 'hook'; event: string; sessionId: string; transcriptPath?: string; notificationType?: string }

/** Process facts plus the agent's own events. */
export type AgentSignal = { type: 'spawned' } | { type: 'exited'; code: number } | HookSignal

export type SessionRef = { sessionId: string; transcriptPath?: string }

/** Checked inside the PTY's prompt queue right before the paste and again before the Enter: a reason means stop there. */
export type SubmitGuard = () => string | null

export interface AgentAdapter {
  readonly id: string
  readonly label: string
  buildSpawn(opts: SpawnOptions): SpawnCommand
  submitPrompt(pty: PromptPty, text: string, guard?: SubmitGuard): Promise<void>
  /** The state after `signal`, given the current one (see domain/state.ts). */
  detectState(current: AgentState, signal: AgentSignal): AgentState
  /** Last assistant message of a session, or null when unknown. */
  /** `thisTurnOnly`: only a reply newer than the last prompt (null while the turn's reply is not recorded yet). */
  readLastMessage(session: SessionRef, thisTurnOnly?: boolean): Promise<string | null>
}

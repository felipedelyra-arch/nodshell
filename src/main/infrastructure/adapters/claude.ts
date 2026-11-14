import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { AgentError, isValidRole } from '../../domain/agent'
import type { AgentAdapter, AgentSignal, AgentState, PromptPty, SessionRef, SpawnCommand, SpawnOptions, SubmitGuard } from '../../domain/adapter'
import { nextState, type Transition } from '../../domain/state'
import { filterEnv } from '../pty/shell'
import { which } from '../which'
import { submitBracketed } from './paste'
import { claudeProjectsDir, readLastAssistantText, validateTranscriptPath } from './transcript'

type Env = Record<string, string | undefined>

const MODEL_RE = /^[a-z0-9][a-z0-9._[\]-]{0,63}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEXT_MAX = 20_000
/** Notification types that mean Claude is blocked on the user. */
const NEEDS_INPUT = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])

/** Claude Code facts -> generic transitions. SessionStart is the ready signal: it does not fire while the trust dialog is open. */
function transition(s: AgentSignal): Transition | null {
  if (s.type === 'spawned') return null // stays starting until the session is really ready
  if (s.type === 'exited') return { exit: s.code }
  switch (s.event) {
    case 'SessionStart':
      return 'ready'
    case 'UserPromptSubmit':
      return 'prompt'
    case 'Stop':
    case 'StopFailure': // the turn ended on an API error
      return 'stop'
    case 'PostToolUse':
      return 'resumed'
    case 'Notification':
      if (s.notificationType === 'idle_prompt') return 'at-input' // also ends a turn interrupted with Esc (no Stop then)
      return s.notificationType !== undefined && NEEDS_INPUT.has(s.notificationType) ? 'needs-input' : null
    default:
      return null
  }
}

/** F1 filter plus the variables a parent Claude Code session leaks (the app is sometimes launched from inside one). */
export function claudeEnv(env: Env): Record<string, string> {
  const out = filterEnv(env)
  for (const k of Object.keys(out)) if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_')) delete out[k]
  return out
}

function text(v: string): string {
  if (v.length > TEXT_MAX || v.includes('\0')) throw new AgentError('Invalid agent option')
  return v
}

function uuid(v: string): string {
  if (!UUID_RE.test(v)) throw new AgentError('Invalid session id')
  return v
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude'
  readonly label = 'Claude Code'
  constructor(private env: Env = process.env) {}

  buildSpawn(o: SpawnOptions): SpawnCommand {
    if (!isValidRole(o.role)) throw new AgentError('Invalid role')
    if (o.model !== undefined && !MODEL_RE.test(o.model)) throw new AgentError('Invalid model')
    // opened from the desktop menu, PATH may lack the CLI's own install directory
    const cmd = which('claude', this.env['PATH']) ?? which('claude', `${this.env['HOME'] ?? ''}/.local/bin`)
    if (!cmd) throw new AgentError('Claude Code not found on PATH')
    // `--opt=value` everywhere: a value starting with "-" can never be parsed as another option
    const args: string[] = []
    if (o.model !== undefined) args.push(`--model=${o.model}`)
    if (o.systemPrompt) args.push(`--append-system-prompt=${text(o.systemPrompt)}`)
    if (o.mcpConfig) args.push(`--mcp-config=${text(o.mcpConfig)}`)
    // the CLI rejects --session-id together with --resume (unless forking): a resumed agent keeps the resumed id
    if (o.hooks) args.push(`--settings=${text(o.hooks.settingsPath)}`)
    args.push(o.resumeId !== undefined ? `--resume=${uuid(o.resumeId)}` : `--session-id=${uuid(o.sessionId)}`)
    // hook variables go in after the filter (which drops AGENT_CANVAS_*)
    return { cmd, args, env: { ...claudeEnv(this.env), ...o.hooks?.env } }
  }

  submitPrompt(pty: PromptPty, prompt: string, guard?: SubmitGuard): Promise<void> {
    return submitBracketed(pty, prompt, undefined, guard)
  }

  detectState(current: AgentState, signal: AgentSignal): AgentState {
    return nextState(current, transition(signal))
  }

  /** Reads the session transcript (path from the hooks, validated again here) from its end. */
  async readLastMessage(s: SessionRef): Promise<string | null> {
    if (!s.transcriptPath) return null
    const home = this.env['HOME']
    const projects = claudeProjectsDir(this.env, home && isAbsolute(home) ? home : homedir())
    const real = validateTranscriptPath(s.transcriptPath, s.sessionId, projects)
    return real ? readLastAssistantText(real) : null
  }
}

import { isAbsolute } from 'node:path'
import { AgentError, isValidRole } from '../../domain/agent'
import type { AgentAdapter, AgentSignal, AgentState, PromptPty, SpawnCommand, SpawnOptions, SubmitGuard } from '../../domain/adapter'
import { nextState } from '../../domain/state'
import { filterEnv } from '../pty/shell'
import { submitBracketed } from './paste'

/** Stub: runs a fixed command (e.g. a shell) behind the same port. Real heuristics arrive in F9. */
export class GenericAdapter implements AgentAdapter {
  readonly id = 'generic'
  constructor(
    readonly label: string,
    private cmd: string,
    private args: string[] = [],
    private env: Record<string, string | undefined> = process.env,
  ) {
    if (!isAbsolute(cmd)) throw new AgentError('Command must be an absolute path')
  }

  buildSpawn(o: SpawnOptions): SpawnCommand {
    if (!isValidRole(o.role)) throw new AgentError('Invalid role')
    return { cmd: this.cmd, args: [...this.args], env: filterEnv(this.env) }
  }

  submitPrompt(pty: PromptPty, prompt: string, guard?: SubmitGuard): Promise<void> {
    return submitBracketed(pty, prompt, undefined, guard)
  }

  /** No hooks: ready as soon as it runs; output heuristics arrive in F9. */
  detectState(current: AgentState, signal: AgentSignal): AgentState {
    return nextState(current, signal.type === 'spawned' ? 'ready' : signal.type === 'exited' ? { exit: signal.code } : null)
  }

  readLastMessage(): Promise<string | null> {
    return Promise.resolve(null)
  }
}

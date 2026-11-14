// Pure domain: no Electron, no sqlite.
import { AgentError } from './agent'
import { validatePreset, type PresetFields } from '../../shared/preset'

export type Preset = PresetFields & { id: string; adapter: 'claude' | 'generic'; builtin: boolean; createdAt: number }

/** Storage port; the sqlite repository implements it. */
export interface PresetRepo {
  list(): Preset[]
  get(id: string): Preset | undefined
  insert(p: Preset): void
  update(p: Preset): void
  /** false when the id is unknown or the preset is built-in */
  delete(id: string): boolean
}

/** The built-in Orchestrator's instructions: how to delegate through the app's MCP tools. */
export const ORCHESTRATOR_PROMPT = [
  'You are the orchestrator of a squad of coding agents. You coordinate; do not write the code yourself unless the user asks.',
  'Work through your agent-canvas tools:',
  '1. When you get a goal, call list_agents to see your squad: names, roles, groups and states.',
  '2. Split the goal into small, concrete tasks, each one an agent can finish in one turn.',
  '3. Delegate with send_message, one task per message, to an agent by name or to a group by name. The first line of the message is the task title; then give the details and what "done" means.',
  '4. When an agent finishes, read its result with read_last_message (replies may also reach you as messages) and decide the next step.',
  '5. Use spawn_agent only when the squad lacks a role or hands; the user must approve it and may deny it.',
  '6. Report progress in one short line with report_status, and summarize the result for the user when every task is done.',
].join('\n')

export const BUILTIN_PRESETS: readonly Omit<PresetFields, 'model'>[] = [
  { name: 'Frontend', role: 'frontend', systemPrompt: 'You are a frontend engineer. Work on UI components, styling, accessibility and client-side behavior. Keep changes small and focused, and explain what you changed.' },
  { name: 'Backend', role: 'backend', systemPrompt: 'You are a backend engineer. Work on APIs, data access, validation and security. Keep changes small and focused, and explain what you changed.' },
  { name: 'Testers', role: 'tester', systemPrompt: 'You are a test engineer. Write and run tests, find edge cases and report failures with clear reproduction steps. Do not change production code unless asked.' },
  { name: 'Reviewers', role: 'reviewer', systemPrompt: 'You are a code reviewer. Review the changes for bugs, security issues and readability. Report concrete findings with file and line; do not rewrite the code yourself.' },
  { name: 'Orchestrator', role: 'orchestrator', systemPrompt: ORCHESTRATOR_PROMPT },
]

export type PresetInput = PresetFields & { id?: string }

/** Create or update; every rule is checked here, whatever the caller already validated. */
export class PresetService {
  constructor(
    private repo: PresetRepo,
    private newId: () => string,
    private now: () => number = Date.now,
  ) {}

  list(): Preset[] {
    return this.repo.list()
  }

  save(input: PresetInput): Preset {
    const v = validatePreset(input)
    if (!v.ok) throw new AgentError(Object.values(v.errors)[0])
    const f = v.value
    const key = f.name.toLowerCase()
    if (this.repo.list().some((p) => p.id !== input.id && p.name.toLowerCase() === key)) throw new AgentError('A preset with that name already exists')
    if (input.id === undefined) {
      const created: Preset = { ...f, id: this.newId(), adapter: 'claude', builtin: false, createdAt: this.now() }
      this.repo.insert(created)
      return created
    }
    const old = this.repo.get(input.id)
    if (!old) throw new AgentError('Unknown preset')
    const updated: Preset = { ...old, ...f }
    this.repo.update(updated)
    return updated
  }

  delete(id: string): void {
    const p = this.repo.get(id)
    if (!p) throw new AgentError('Unknown preset')
    if (p.builtin) throw new AgentError('Built-in presets cannot be deleted')
    this.repo.delete(id)
  }

  get(id: string): Preset | undefined {
    return this.repo.get(id)
  }
}

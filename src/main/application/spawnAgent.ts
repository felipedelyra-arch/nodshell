import { AgentError, type Repo } from '../domain/agent'
import type { Preset } from '../domain/preset'
import { SQUAD_EXTRAS_MAX } from '../domain/squad'
import { cleanLine, previewText } from '../domain/task'
import type { SpawnedAgent, SpawnRequest } from './agents'
import { connectSquad } from './createSquad'
import type { FlowEngine } from './flow'
import type { GroupRegistry } from './groups'
import type { SpawnInput } from './mcpTools'
import { presetRequest, type Slots } from './spawnMany'
import type { SquadRegistry } from './squads'
import type { TaskBoard } from './tasks'

/** The Orchestrator asking: its identity comes from its MCP token, never from the request. */
export type Caller = { id: string; ownerId: number; name: string; role: string; workspaceId?: string }
/** Shown to the user before anything starts; plain text only. */
export type SpawnQuestion = { orchestrator: string; preset: string; model: string; task: string }
/** A card that joined a squad: `group.created` when its role had no group in the squad yet; squadId null when the squad went away meanwhile. */
export type SpawnJoined = { squadId: string | null; group: { id: string; name: string; role: string; created: boolean } | null; agent: SpawnedAgent; workspaceId?: string }

export type SpawnAgentDeps = {
  presets: { list(): Preset[] }
  agents: { spawn(ownerId: number, repo: Repo | null, req: SpawnRequest): Promise<SpawnedAgent>; get(ownerId: number, id: string): { role: string } | undefined }
  groups: GroupRegistry
  squads: SquadRegistry
  slots: Slots
  flow: Pick<FlowEngine, 'create' | 'hold' | 'charge'>
  tasks: Pick<TaskBoard, 'create' | 'settle'>
  repo(): Repo | null
  /** processes stopped by Pause all */
  paused(ownerId: number): boolean
  /** the user's answer; anything but an explicit yes is a no */
  confirm(ownerId: number, q: SpawnQuestion): Promise<boolean>
  joined(ownerId: number, j: SpawnJoined): void
  now?: () => number
}

const SIZE = { cols: 80, rows: 24 }
/** After a Deny (or a dialog left unanswered) the same Orchestrator waits this long before asking again. */
export const DENY_COOLDOWN_MS = 60_000
/** This many Denies in a row and it may not ask again until the user prompts it. */
export const DENY_STREAK_MAX = 3

/**
 * SpawnAgent for an Orchestrator (MCP spawn_agent): only for the one leading a squad, only from an existing preset (never another
 * Orchestrator), within the live-process limit (a slot is reserved), at most SQUAD_EXTRAS_MAX extras per squad, one request at a
 * time per Orchestrator, never while paused, counted by the burst guard, and only after the user approves it in a dialog.
 * Every limit is checked before the dialog and again after it. The agent joins the squad group of its role (a new group, linked to
 * the Orchestrator, when there is none) and gets the task as its first prompt on its first idle, as a task of the squad.
 */
export class SquadSpawner {
  private asking = new Set<string>() // Orchestrators with a request in flight
  private denied = new Map<string, { streak: number; until: number }>() // so a looping agent cannot wear the user down with dialogs
  constructor(private d: SpawnAgentDeps) {}

  /** The user prompted this Orchestrator (from the app or in its terminal): it may ask again. */
  userPrompted(agentId: string): void {
    this.denied.delete(agentId)
  }

  forget(agentId: string): void {
    this.denied.delete(agentId)
  }

  async spawn(me: Caller, input: SpawnInput): Promise<string> {
    const o = me.ownerId
    const now = this.d.now ?? Date.now
    const no = this.denied.get(me.id)
    if (no && no.streak >= DENY_STREAK_MAX) throw new AgentError(`The user denied ${DENY_STREAK_MAX} requests in a row; spawn_agent is off until the user prompts you again`)
    if (no && now() < no.until) throw new AgentError(`The user denied your last request; wait ${Math.ceil((no.until - now()) / 1000)} s before asking again`)
    if (this.asking.has(me.id)) throw new AgentError('Another spawn request of yours is still waiting')
    this.asking.add(me.id)
    try {
      const first = this.check(me, input)
      this.d.flow.charge(o) // the request itself counts toward the burst guard
      const model = input.model ?? first.preset.model ?? 'default'
      const yes = await this.d.confirm(o, { orchestrator: me.name, preset: cleanLine(first.preset.name), model, task: previewText(input.task) })
      if (!yes) {
        const streak = (this.denied.get(me.id)?.streak ?? 0) + 1
        this.denied.set(me.id, { streak, until: now() + DENY_COOLDOWN_MS })
        throw new AgentError('The user denied the request, nothing was started')
      }
      this.denied.delete(me.id)
      const { preset, squadId } = this.check(me, input) // the world may have changed while the dialog was open
      const slot = this.d.slots.reserve(1)
      let a: SpawnedAgent
      try {
        a = await this.d.agents.spawn(o, this.d.repo(), { ...presetRequest(preset, { ...SIZE, workspaceId: me.workspaceId }), model: input.model ?? preset.model ?? undefined })
      } finally {
        slot.release()
      }
      // from here nothing may throw: the agent runs and needs its card
      return this.place(me, squadId, preset, a, input.task)
    } finally {
      this.asking.delete(me.id)
    }
  }

  private check(me: Caller, input: SpawnInput): { preset: Preset; squadId: string } {
    const o = me.ownerId
    const s = this.d.squads.list(o).find((x) => x.orchestratorId === me.id)
    if (!s) throw new AgentError('Only an Orchestrator leading a squad can spawn agents')
    if (this.d.paused(o)) throw new AgentError('Everything is paused')
    const preset = this.d.presets.list().find((p) => p.name.toLowerCase() === input.preset.toLowerCase())
    if (!preset) throw new AgentError(`No preset named ${input.preset}`)
    if (preset.role === 'orchestrator') throw new AgentError('An Orchestrator cannot spawn another Orchestrator')
    if (s.extraIds.length >= SQUAD_EXTRAS_MAX) throw new AgentError(`Your squad already has ${SQUAD_EXTRAS_MAX} extra agents`)
    this.d.slots.check(1)
    return { preset, squadId: s.id }
  }

  private place(me: Caller, squadId: string, preset: Preset, a: SpawnedAgent, task: string): string {
    const o = me.ownerId
    const s = this.d.squads.get(o, squadId)
    if (!s) {
      this.d.joined(o, { squadId: null, group: null, agent: a, workspaceId: me.workspaceId })
      return `Started ${a.name}, but your squad is gone, so the task was not given`
    }
    const existing = s.groupIds.map((id) => this.d.groups.get(o, id)).find((g) => g?.memberIds.some((m) => this.d.agents.get(o, m)?.role === preset.role))
    const g = existing ? this.d.groups.addMembers(o, existing.id, [a.id]) : this.d.groups.create(o, preset.name, [a.id], { spawned: true })
    this.d.squads.addExtra(s, a.id, g.id)
    this.d.joined(o, { squadId: s.id, group: { id: g.id, name: g.name, role: preset.role, created: !existing }, agent: a, workspaceId: me.workspaceId })
    if (!existing) connectSquad(this.d.flow, o, { id: s.id, groupIds: [g.id] }, [])
    const t = this.d.tasks.create(o, s.id, task, { kind: 'agent', id: a.id, name: a.name }, [a.id])
    try {
      this.d.flow.hold(o, me.id, { id: a.id, name: a.name, role: a.role, workspaceId: me.workspaceId }, `From ${me.name} (${me.role}):\n${task}`, t.id)
    } catch (e) {
      return `Started ${a.name} in ${g.name}, but the task was not queued: ${e instanceof AgentError ? e.message : 'the request failed'}`
    } finally {
      this.d.tasks.settle(t.id)
    }
    return `Started ${a.name} (${preset.name}) in group ${g.name}. Your task goes to ${a.name} as its first prompt once it is ready`
  }
}

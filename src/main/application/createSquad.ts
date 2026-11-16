import { AgentError, type Repo } from '../domain/agent'
import type { Preset } from '../domain/preset'
import { SQUAD_GROUP_SIZE, SQUAD_ROLES, type SquadRole } from '../domain/squad'
import type { Edge } from '../domain/edge'
import type { SpawnedAgent } from './agents'
import type { FlowEngine } from './flow'
import { presetRequest, spawnBatch, type SpawnManyDeps, type SpawnSize } from './spawnMany'
import type { SquadRegistry } from './squads'

export type SquadDeps = Omit<SpawnManyDeps, 'presets'> & { presets: { list(): Preset[] }; squads: SquadRegistry; flow: Pick<FlowEngine, 'create'> }

export type SquadResult = {
  squad: { id: string; orchestratorId: string; groupIds: string[] }
  orchestrator: SpawnedAgent
  groups: { id: string; name: string; role: SquadRole; memberIds: string[] }[]
  agents: SpawnedAgent[]
  /** one active edge per group, group -> Orchestrator */
  edges: Edge[]
  failed: number
}

/**
 * CreateSquad: an Orchestrator plus one new group of `perGroup` agents (1 to SQUAD_GROUP_SIZE) per squad role, from the built-in presets.
 * Each group carries its preset, so Spawn N of that preset adds agents to it later.
 * Refuses before anything is created when there is no room for the whole squad. If the Orchestrator fails nothing else starts;
 * after that, like Spawn N, the agents that started stay and failures are counted (a group with no agent is not created).
 */
export async function createSquad(d: SquadDeps, ownerId: number, repo: Repo | null, size: SpawnSize, perGroup: number = SQUAD_GROUP_SIZE): Promise<SquadResult> {
  if (!repo) throw new AgentError('Open a repository first')
  const builtin = (role: string) => d.presets.list().find((p) => p.builtin && p.role === role)
  const lead = builtin('orchestrator')
  const members = SQUAD_ROLES.map((role) => ({ role, preset: builtin(role) }))
  if (!lead || members.some((m) => !m.preset)) throw new AgentError('The built-in presets for a squad are missing')
  const total = 1 + SQUAD_ROLES.length * perGroup
  const slots = d.slots.reserve(total)
  const started: { role: SquadRole; preset: Preset; agents: SpawnedAgent[] }[] = []
  let orchestrator: SpawnedAgent
  try {
    orchestrator = await d.agents.spawn(ownerId, repo, presetRequest(lead, size))
    slots.use()
    for (const { role, preset } of members) started.push({ role, preset: preset!, agents: (await spawnBatch(d, ownerId, repo, preset!, perGroup, size, slots)).agents })
  } finally {
    slots.release()
  }
  // from here nothing may throw: the agents run and need their cards, even one whose process already exited
  const groups: SquadResult['groups'] = []
  for (const { role, preset, agents } of started.filter((x) => x.agents.length > 0)) {
    const g = d.groups.create(ownerId, preset.name, agents.map((a) => a.id), { presetId: preset.id, spawned: true, workspaceId: size.workspaceId })
    groups.push({ id: g.id, name: g.name, role, memberIds: [...g.memberIds] })
  }
  const agents = started.flatMap((x) => x.agents)
  const s = d.squads.create(ownerId, orchestrator.id, groups.map((g) => g.id))
  return { squad: { id: s.id, orchestratorId: s.orchestratorId, groupIds: [...s.groupIds] }, orchestrator, groups, agents, edges: connectSquad(d.flow, ownerId, s, []), failed: total - 1 - agents.length }
}

/**
 * Connect: an edge from each of the squad's groups that still exists to its Orchestrator, unless it is already there.
 * Never throws (a group that went away meanwhile is skipped); returns the edges created.
 */
export function connectSquad(flow: Pick<FlowEngine, 'create'>, ownerId: number, s: { id: string; groupIds: string[] }, existing: Edge[]): Edge[] {
  const has = (gid: string) => existing.some((e) => e.source.kind === 'group' && e.source.id === gid && e.target.kind === 'squad' && e.target.id === s.id)
  return s.groupIds.filter((gid) => !has(gid)).flatMap((gid) => {
    try {
      return [flow.create(ownerId, { kind: 'group', id: gid }, { kind: 'squad', id: s.id })]
    } catch {
      return []
    }
  })
}

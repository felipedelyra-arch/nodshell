import { AgentError, type Repo } from '../domain/agent'
import type { Preset } from '../domain/preset'
import type { SpawnedAgent, SpawnRequest } from './agents'
import type { GroupRegistry } from './groups'

export type SpawnManyDeps = {
  presets: { get(id: string): Preset | undefined }
  agents: { spawn(ownerId: number, repo: Repo | null, req: SpawnRequest): Promise<SpawnedAgent> }
  groups: GroupRegistry
  slots: Slots
}

export type SpawnManyResult = { agents: SpawnedAgent[]; group: { id: string; name: string; memberIds: string[] }; failed: number }

/** Refuses before anything is created. No colons: the renderer shows this text. */
export function checkCapacity(free: number, count: number, limit: number): void {
  if (count > free) throw new AgentError(`Only ${Math.max(free, 0)} of ${limit} terminals are free, cannot start ${count}`)
}

export type Reservation = { /** one reserved slot was spent (its spawn ended, started or not) */ use(): void; /** gives back what is left */ release(): void }

/** Live-process budget shared by every batch: slots a running batch still has to fill are reserved, so two batches cannot both pass the check. */
export class Slots {
  private reserved = 0
  constructor(
    private used: () => number,
    private max: number | (() => number),
  ) {}

  get limit(): number {
    return typeof this.max === 'number' ? this.max : this.max()
  }

  /** A batch still has slots to fill: some spawn is in flight. */
  get pending(): boolean {
    return this.reserved > 0
  }

  free(): number {
    return this.limit - this.used() - this.reserved
  }

  /** Throws (nothing created yet) when `count` do not fit. */
  reserve(count: number): Reservation {
    checkCapacity(this.free(), count, this.limit)
    this.reserved += count
    let left = count
    return {
      use: () => {
        if (left === 0) return
        left--
        this.reserved--
      },
      release: () => {
        this.reserved -= left
        left = 0
      },
    }
  }
}

/** `size` also carries the workspace the agents belong to. */
export type SpawnSize = { cols: number; rows: number; workspaceId?: string }
export const presetRequest = (p: Preset, size: SpawnSize): SpawnRequest => ({ role: p.role, model: p.model ?? undefined, systemPrompt: p.systemPrompt || undefined, cols: size.cols, rows: size.rows, workspaceId: size.workspaceId, presetId: p.id })

/** Spawns `count` agents of a preset, one at a time (each worktree takes the lowest free <role>-<n>). The ones that started stay even if others fail. */
export async function spawnBatch(d: Pick<SpawnManyDeps, 'agents'>, ownerId: number, repo: Repo, preset: Preset, count: number, size: SpawnSize, slots: Reservation): Promise<{ agents: SpawnedAgent[]; firstError: unknown }> {
  const agents: SpawnedAgent[] = []
  let firstError: unknown
  for (let i = 0; i < count; i++) {
    try {
      agents.push(await d.agents.spawn(ownerId, repo, presetRequest(preset, size)))
    } catch (e) {
      firstError ??= e
    } finally {
      slots.use()
    }
  }
  return { agents, firstError }
}

/** Spawn N of a preset into that preset's group (created on first use). Agents that started stay even if others fail. */
export async function spawnMany(d: SpawnManyDeps, ownerId: number, repo: Repo | null, req: { presetId: string; count: number; cols: number; rows: number; workspaceId?: string }): Promise<SpawnManyResult> {
  if (!repo) throw new AgentError('Open a repository first')
  const preset = d.presets.get(req.presetId)
  if (!preset) throw new AgentError('Unknown preset')
  const slots = d.slots.reserve(req.count)
  let agents: SpawnedAgent[]
  try {
    const batch = await spawnBatch(d, ownerId, repo, preset, req.count, req, slots)
    if (batch.agents.length === 0) throw batch.firstError
    agents = batch.agents
  } finally {
    slots.release()
  }
  // from here nothing may throw: the agents run and need their cards, even one whose process already exited
  const ids = agents.map((a) => a.id)
  const existing = d.groups.findByPreset(ownerId, preset.id, req.workspaceId)
  const g = existing ? d.groups.addMembers(ownerId, existing.id, ids) : d.groups.create(ownerId, preset.name, ids, { presetId: preset.id, spawned: true, workspaceId: req.workspaceId })
  return { agents, group: { id: g.id, name: g.name, memberIds: [...g.memberIds] }, failed: req.count - agents.length }
}

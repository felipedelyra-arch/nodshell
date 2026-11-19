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

export type Reservation = { /** one reserved slot was spent (its spawn ended, started or not); `agent: false` for a console, which holds no memory worth counting */ use(agent?: boolean): void; /** gives back what is left */ release(): void }

/** What one coding agent ends up holding (measured with the real CLI: 9 agents and the app took about 12.5 GB). */
export const AGENT_BYTES = 1.2 * 2 ** 30
/** Memory always left to the rest of the system. */
export const RESERVE_BYTES = 2 ** 30
// a terminal that just started has not grown into its memory yet: it still counts against the room for this long
const SETTLE_MS = 30_000

/** What one more agent costs: the mean memory of the agents that settled, never below AGENT_BYTES. Consoles are not passed in. */
export function agentCost(agents: { bytes: number; ageMs: number }[]): number {
  const settled = agents.filter((a) => a.ageMs >= SETTLE_MS)
  if (settled.length === 0) return AGENT_BYTES
  return Math.max(AGENT_BYTES, settled.reduce((n, a) => n + a.bytes, 0) / settled.length)
}

/**
 * Live-process budget shared by every batch: slots a running batch still has to fill are reserved, so two batches cannot both pass
 * the check. With `avail` (memory the system can still hand out) the budget is also what fits in memory.
 */
export class Slots {
  private reserved = 0
  private started: number[] = []
  constructor(
    private used: () => number,
    private max: number | (() => number),
    private avail: () => number | null = () => null,
    private now: () => number = Date.now,
    private perAgent: () => number = () => AGENT_BYTES,
  ) {}

  /** Memory one more agent is budgeted at now. */
  get agentBytes(): number {
    return Math.max(AGENT_BYTES, this.perAgent())
  }

  get limit(): number {
    return typeof this.max === 'number' ? this.max : this.max()
  }

  /** A batch still has slots to fill: some spawn is in flight. */
  get pending(): boolean {
    return this.reserved > 0
  }

  /** Free terminals by the limit alone (a console costs no memory worth counting). */
  freeOfLimit(): number {
    return this.limit - this.used() - this.reserved
  }

  /** How many more agents fit in memory; Infinity where the system does not say. */
  private room(): number {
    const avail = this.avail()
    if (avail === null) return Infinity
    const t = this.now()
    this.started = this.started.filter((s) => t - s < SETTLE_MS)
    return Math.floor((avail - RESERVE_BYTES) / this.agentBytes) - this.started.length - this.reserved
  }

  free(): number {
    return Math.min(this.freeOfLimit(), this.room())
  }

  /** Throws when `count` do not fit, saying which of the two ran out. No colons: the renderer shows this text. */
  check(count: number): void {
    if (count <= 0) return
    checkCapacity(this.freeOfLimit(), count, this.limit)
    const room = this.room()
    if (count > room) throw new AgentError(`Not enough free memory to start ${count} more, there is room for ${Math.max(room, 0)}. Close some terminals first`)
  }

  /** Throws (nothing created yet) when `count` do not fit; `granted`: the caller already took them from `free()`, so they are not checked again. */
  reserve(count: number, granted = false): Reservation {
    if (!granted) this.check(count)
    this.reserved += count
    let left = count
    return {
      use: (agent = true) => {
        if (left === 0) return
        left--
        this.reserved--
        if (agent) this.started.push(this.now())
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

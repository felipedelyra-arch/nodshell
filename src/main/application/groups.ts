import { AgentError } from '../domain/agent'

export type Group = { id: string; ownerId: number; name: string; memberIds: string[]; presetId?: string; workspaceId?: string }

/**
 * Group membership, in memory (persistence is F8). A card belongs to at most one group; a group without members disappears.
 * `owns` says whether a window owns a terminal/agent id.
 */
export class GroupRegistry {
  private groups = new Map<string, Group>()
  constructor(
    private owns: (ownerId: number, id: string) => boolean,
    private newId: () => string,
  ) {}

  /** `spawned`: ids a use case has just started for this owner; not checked against live processes, since one may already have exited (its card shows it and stays closable). */
  private check(ownerId: number, ids: string[], spawned: boolean): void {
    if (new Set(ids).size !== ids.length) throw new AgentError('Duplicate cards')
    for (const id of ids) {
      if (!spawned && !this.owns(ownerId, id)) throw new AgentError('Unknown card')
      if (this.groupOf(id)) throw new AgentError('A card can only be in one group')
    }
  }

  /** `id`: a saved group coming back keeps its id (edges and squads point at it). */
  create(ownerId: number, name: string, memberIds: string[], opts: { presetId?: string; spawned?: boolean; workspaceId?: string; id?: string } = {}): Group {
    const { presetId, spawned = false, workspaceId } = opts
    if (memberIds.length === 0) throw new AgentError('A group needs at least one card')
    this.check(ownerId, memberIds, spawned)
    if (opts.id !== undefined && this.groups.has(opts.id)) throw new AgentError('Duplicate group')
    const g: Group = { id: opts.id ?? this.newId(), ownerId, name, memberIds: [...memberIds], presetId, workspaceId }
    this.groups.set(g.id, g)
    return g
  }

  /** Only for agents a use case has just spawned (see `check`). */
  addMembers(ownerId: number, groupId: string, ids: string[]): Group {
    const g = this.owned(ownerId, groupId)
    this.check(ownerId, ids, true)
    g.memberIds.push(...ids)
    return g
  }

  /** A preset's group is per workspace: the same preset in another workspace gets its own group. */
  findByPreset(ownerId: number, presetId: string, workspaceId?: string): Group | undefined {
    return [...this.groups.values()].find((g) => g.ownerId === ownerId && g.presetId === presetId && g.workspaceId === workspaceId)
  }

  get(ownerId: number, id: string): Group | undefined {
    const g = this.groups.get(id)
    return g?.ownerId === ownerId ? g : undefined
  }

  list(ownerId: number): Group[] {
    return [...this.groups.values()].filter((g) => g.ownerId === ownerId)
  }

  groupOf(id: string): Group | undefined {
    return [...this.groups.values()].find((g) => g.memberIds.includes(id))
  }

  dissolve(ownerId: number, groupId: string): void {
    this.owned(ownerId, groupId)
    this.groups.delete(groupId)
  }

  /** A card was closed: leaves its group, which is removed when it becomes empty. */
  forget(id: string): void {
    const g = this.groupOf(id)
    if (!g) return
    g.memberIds = g.memberIds.filter((m) => m !== id)
    if (g.memberIds.length === 0) this.groups.delete(g.id)
  }

  dropOwner(ownerId: number): void {
    for (const g of [...this.groups.values()]) if (g.ownerId === ownerId) this.groups.delete(g.id)
  }

  get size(): number {
    return this.groups.size
  }

  private owned(ownerId: number, id: string): Group {
    const g = this.groups.get(id)
    if (!g || g.ownerId !== ownerId) throw new AgentError('Unknown group')
    return g
  }
}

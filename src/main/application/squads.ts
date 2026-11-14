import type { Squad } from '../domain/squad'

/** Squads, in memory (persistence is F8). A squad lives as long as its Orchestrator; closing it leaves the groups as plain groups. */
export class SquadRegistry {
  private squads = new Map<string, Squad>()
  constructor(private newId: () => string) {}

  /** Only for an Orchestrator a use case has just spawned (or restored, with its saved id and extras) for `ownerId`; never fails, even if its process already exited. */
  create(ownerId: number, orchestratorId: string, groupIds: string[], saved?: { id: string; extraIds: string[] }): Squad {
    const s: Squad = { id: saved && !this.squads.has(saved.id) ? saved.id : this.newId(), ownerId, orchestratorId, groupIds: [...groupIds], extraIds: [...(saved?.extraIds ?? [])] }
    this.squads.set(s.id, s)
    return s
  }

  get(ownerId: number, id: string): Squad | undefined {
    const s = this.squads.get(id)
    return s?.ownerId === ownerId ? s : undefined
  }

  list(ownerId: number): Squad[] {
    return [...this.squads.values()].filter((s) => s.ownerId === ownerId)
  }

  /** spawn_agent added an agent, in a group of the squad (a new one when `groupId` is not listed yet). */
  addExtra(s: Squad, agentId: string, groupId: string): void {
    s.extraIds.push(agentId)
    if (!s.groupIds.includes(groupId)) s.groupIds.push(groupId)
  }

  /** An agent was closed: when it led a squad, the squad goes (its groups stay); an extra frees its place. Returns the squad dropped, if any. */
  forget(agentId: string): Squad | undefined {
    for (const x of this.squads.values()) x.extraIds = x.extraIds.filter((id) => id !== agentId)
    const s = [...this.squads.values()].find((x) => x.orchestratorId === agentId)
    if (s) this.squads.delete(s.id)
    return s
  }

  dropOwner(ownerId: number): void {
    for (const s of [...this.squads.values()]) if (s.ownerId === ownerId) this.squads.delete(s.id)
  }
}

import { AgentError } from '../domain/agent'

export type SwitchDeps = {
  /** a spawn is still in flight (a reserved slot or a pending agent): its agent has no card yet */
  starting(): boolean
  /** every agent and console main knows for the window, whatever the renderer shows */
  ownedIds(): string[]
  closeAll(ids: string[]): Promise<{ closed: boolean; kept: number; archived: number }>
}

/** Refuses, with a message the renderer can show, while agents are still starting. */
export function assertNotStarting(d: Pick<SwitchDeps, 'starting'>): void {
  if (d.starting()) throw new AgentError('Wait for the agents to finish starting')
}

/** Leaving a project: ends everything of the window after one question. `changed` is false when the user keeps it running (the repository then stays). */
export async function endProject(d: SwitchDeps): Promise<{ changed: boolean; kept: number; archived: number }> {
  assertNotStarting(d)
  const ids = d.ownedIds()
  if (ids.length === 0) return { changed: true, kept: 0, archived: 0 }
  const r = await d.closeAll(ids)
  return { changed: r.closed, kept: r.kept, archived: r.archived }
}

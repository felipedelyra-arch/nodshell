import { AgentError } from '../domain/agent'

/** What closing a batch of terminals needs from the rest of main (agents, consoles, groups, squads). */
export type CloseDeps = {
  /** an agent or a console of that window */
  owns(ownerId: number, id: string): boolean
  isAgent(ownerId: number, id: string): boolean
  /** closing it would stop a running process */
  needsConfirm(ownerId: number, id: string): boolean
  /** same policy as closing one agent: hooks removed, worktree handled, its own "uncommitted work" dialog */
  closeAgent(id: string): Promise<string>
  killPty(id: string): Promise<void>
  forget(id: string): void
}

/** Closes many terminals with one confirmation. An id of another window or an unknown one rejects the whole batch before anything is closed. */
export async function closeTerminals(d: CloseDeps, ownerId: number, ids: string[], confirm: () => Promise<boolean>): Promise<{ closed: boolean; kept: number; archived: number }> {
  const unique = [...new Set(ids)]
  if (!unique.every((id) => d.owns(ownerId, id))) throw new AgentError('Unknown terminal')
  if (unique.some((id) => d.needsConfirm(ownerId, id)) && !(await confirm())) return { closed: false, kept: 0, archived: 0 }
  let kept = 0 // worktrees left with uncommitted work
  let archived = 0 // branches left with commits
  for (const id of unique) {
    try {
      if (d.isAgent(ownerId, id)) {
        const outcome = await d.closeAgent(id)
        if (outcome === 'kept') kept++
        else if (outcome === 'archived') archived++
      } else await d.killPty(id)
    } catch {
      // already gone (closed meanwhile or exited); the rest must still close
    } finally {
      d.forget(id)
    }
  }
  return { closed: true, kept, archived }
}

/**
 * Closes one agent. What it belonged to (group, squad, edges) is forgotten only once it is really gone: not when the user kept it
 * running, nor when the close was refused (an id of another window), but also when the close failed after stopping it.
 */
export async function closeAgent<T>(d: { has(): boolean; close(): Promise<T>; forget(): void }): Promise<T> {
  const mine = d.has()
  try {
    return await d.close()
  } finally {
    if (mine && !d.has()) d.forget()
  }
}

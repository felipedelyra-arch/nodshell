import { cleanMemory, MEMORY_MAX, memoryBytes, type MemoryScope } from '../../shared/memory'
import { AgentError } from '../domain/agent'

export type MemoryEntry = { content: string; updatedAt: number; updatedBy: string }
export type MemoryRepo = { get(scope: MemoryScope, key: string): MemoryEntry | null; set(scope: MemoryScope, key: string, e: MemoryEntry): void }
export type MemoryView = { content: string; updatedAt: number | null; updatedBy: string | null }

/**
 * Memory: one markdown text global and one per repository (key = its root, known only to main), each at most MEMORY_MAX bytes.
 * Plain text, cleaned of control characters; never injected anywhere and never logged.
 */
export class MemoryService {
  constructor(
    private repo: MemoryRepo,
    private now: () => number = Date.now,
  ) {}

  private key(scope: MemoryScope, root: string | null): string {
    if (scope === 'global') return ''
    if (!root) throw new AgentError('Open a repository first')
    return root
  }

  read(scope: MemoryScope, root: string | null): MemoryView {
    const e = this.repo.get(scope, this.key(scope, root))
    return e ? { ...e } : { content: '', updatedAt: null, updatedBy: null }
  }

  /** `append` adds after what is there (on a new line); the whole text must still fit. */
  write(scope: MemoryScope, root: string | null, content: string, by: string, mode: 'replace' | 'append' = 'replace'): MemoryView {
    const key = this.key(scope, root)
    const text = cleanMemory(content)
    const before = mode === 'append' ? (this.repo.get(scope, key)?.content ?? '') : ''
    const next = before && text ? `${before}${before.endsWith('\n') ? '' : '\n'}${text}` : before + text
    if (memoryBytes(next) > MEMORY_MAX) throw new AgentError(`Memory is limited to ${MEMORY_MAX / 1024} KiB`)
    const e = { content: next, updatedAt: this.now(), updatedBy: by }
    this.repo.set(scope, key, e)
    return { ...e }
  }
}

/** memory_read/memory_write for an agent: always its own repository (from its worktree), signed with its name, counted by the burst guard. */
export function agentMemory(
  m: MemoryService,
  d: { rootOf(agentId: string): string | null; charge(ownerId: number): void; changed(ownerId: number, scope: MemoryScope, view: MemoryView, by: string): void },
): { read(me: { id: string }, scope: MemoryScope): string; write(me: { id: string; ownerId: number; name: string }, scope: MemoryScope, content: string, mode: 'replace' | 'append'): void } {
  return {
    read: (me, scope) => m.read(scope, d.rootOf(me.id)).content,
    write: (me, scope, content, mode) => {
      const root = d.rootOf(me.id)
      d.charge(me.ownerId) // refused while flows are paused, and too many in a row pause them
      const v = m.write(scope, root, content, me.name, mode)
      d.changed(me.ownerId, scope, v, me.name)
    },
  }
}

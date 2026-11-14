import { describe, expect, it, vi } from 'vitest'
import { FlowEngine } from '../../src/main/application/flow'
import { callTool, type Peer, type ToolDeps } from '../../src/main/application/mcpTools'
import { agentMemory, MemoryService, type MemoryEntry, type MemoryRepo } from '../../src/main/application/memory'
import { BURST_MAX } from '../../src/main/domain/edge'
import { cleanMemory, MEMORY_MAX, memoryBytes } from '../../src/shared/memory'

class MapRepo implements MemoryRepo {
  rows = new Map<string, MemoryEntry>()
  get(scope: string, key: string) {
    return this.rows.get(`${scope}|${key}`) ?? null
  }
  set(scope: string, key: string, e: MemoryEntry) {
    this.rows.set(`${scope}|${key}`, e)
  }
}

describe('cleanMemory', () => {
  it('keeps text, line breaks and tabs; drops other control characters', () => {
    expect(cleanMemory('a\r\nb\rc\td\u0000e\u001b[31mf\u007fg')).toBe('a\nb\nc\tde[31mfg')
    expect(memoryBytes('é')).toBe(2)
  })
})

describe('memory tools', () => {
  const peers: Peer[] = [
    { id: 'zoe', ownerId: 1, workspaceId: 'w1', name: 'Zoe', role: 'frontend', state: 'idle' },
    { id: 'kai', ownerId: 1, workspaceId: 'w1', name: 'Kai', role: 'backend', state: 'idle' },
  ]
  // Kai's worktree belongs to another repository (e.g. left from another project): its repo scope is that one, never Zoe's
  const roots: Record<string, string> = { zoe: '/projects/a', kai: '/projects/b' }
  function setup() {
    const repo = new MapRepo()
    const m = new MemoryService(repo, () => 42)
    let now = 0
    const flow = new FlowEngine({ agent: () => undefined, group: () => undefined, groupOf: () => undefined, squad: () => undefined, lastMessage: async () => null, readiness: () => 'idle', deliver: async () => undefined, now: () => now, emit: () => undefined }, () => 'e')
    const changed = vi.fn()
    const d = {
      agent: (aid: string) => peers.find((p) => p.id === aid),
      agents: () => peers,
      groups: () => [],
      squads: () => [],
      groupOf: () => undefined,
      lastMessage: async () => null,
      report: () => undefined,
      paused: () => false,
      flow,
      tasks: { create: vi.fn(), settle: vi.fn() },
      spawn: vi.fn(),
      memory: agentMemory(m, { rootOf: (aid) => roots[aid] ?? null, charge: (o) => flow.charge(o), changed }),
    } as unknown as ToolDeps
    return { d, m, repo, flow, changed, tick: (ms: number) => (now += ms) }
  }

  it('repo scope is the agent\'s own repository; global is shared; writes are signed and announced (never their text)', async () => {
    const { d, m, changed } = setup()
    expect(await callTool(d, 'zoe', 'memory_read', { scope: 'repo' })).toEqual({ text: 'The repo memory is empty', isError: false })
    expect(await callTool(d, 'zoe', 'memory_write', { scope: 'repo', content: 'use pnpm', mode: 'replace' })).toEqual({ text: 'Saved the repo memory', isError: false })
    expect(await callTool(d, 'kai', 'memory_read', { scope: 'repo' })).toEqual({ text: 'The repo memory is empty', isError: false })
    expect(m.read('repo', '/projects/a')).toEqual({ content: 'use pnpm', updatedAt: 42, updatedBy: 'Zoe' })
    expect(changed).toHaveBeenLastCalledWith(1, 'repo', { content: 'use pnpm', updatedAt: 42, updatedBy: 'Zoe' }, 'Zoe')
    await callTool(d, 'kai', 'memory_write', { scope: 'global', content: 'shared', mode: 'replace' })
    await callTool(d, 'zoe', 'memory_write', { scope: 'global', content: 'more', mode: 'append' })
    expect(await callTool(d, 'kai', 'memory_read', { scope: 'global' })).toEqual({ text: 'shared\nmore', isError: false })
    expect(m.read('global', null).updatedBy).toBe('Zoe')
  })

  it('validates scope, mode and size; strips control characters; append respects the total limit', async () => {
    const { d, m } = setup()
    for (const args of [{ scope: 'other' }, { scope: '../etc' }, {}]) expect(await callTool(d, 'zoe', 'memory_read', args)).toEqual({ text: 'Invalid arguments', isError: true })
    for (const args of [{ scope: 'repo', content: 'x' }, { scope: 'repo', content: 'x', mode: 'merge' }, { scope: 'repo', content: 'x'.repeat(MEMORY_MAX + 1), mode: 'replace' }, { scope: 'repo', content: 7, mode: 'replace' }])
      expect(await callTool(d, 'zoe', 'memory_write', args)).toEqual({ text: 'Invalid arguments', isError: true })
    await callTool(d, 'zoe', 'memory_write', { scope: 'repo', content: 'a\u001b]0;pwned\u0007\tb\r\nc', mode: 'replace' })
    expect(m.read('repo', '/projects/a').content).toBe('a]0;pwned\tb\nc')
    expect(await callTool(d, 'zoe', 'memory_write', { scope: 'repo', content: 'é'.repeat(MEMORY_MAX / 2 + 1), mode: 'replace' })).toEqual({ text: 'Memory is limited to 64 KiB', isError: true })
    await callTool(d, 'zoe', 'memory_write', { scope: 'repo', content: 'x'.repeat(MEMORY_MAX - 1), mode: 'replace' })
    expect(await callTool(d, 'zoe', 'memory_write', { scope: 'repo', content: 'y', mode: 'append' })).toEqual({ text: 'Memory is limited to 64 KiB', isError: true })
    expect(memoryBytes(m.read('repo', '/projects/a').content)).toBe(MEMORY_MAX - 1)
  })

  it('every write counts toward the burst guard; once it trips, writes are refused until flows resume', async () => {
    const { d, flow } = setup()
    for (let i = 0; i < BURST_MAX; i++) expect(await callTool(d, 'zoe', 'memory_write', { scope: 'global', content: `${i}`, mode: 'replace' })).toMatchObject({ isError: false })
    expect(await callTool(d, 'zoe', 'memory_write', { scope: 'global', content: 'one too many', mode: 'replace' })).toEqual({ text: 'Too many messages, all flows paused', isError: true })
    expect(flow.flowsPaused(1)).toBe(true)
    expect(await callTool(d, 'zoe', 'memory_write', { scope: 'global', content: 'x', mode: 'replace' })).toEqual({ text: 'Flows are paused', isError: true })
    expect(await callTool(d, 'zoe', 'memory_read', { scope: 'global' })).toMatchObject({ isError: false }) // reading is never counted
    flow.resumeAll(1)
    expect(await callTool(d, 'zoe', 'memory_write', { scope: 'global', content: 'x', mode: 'replace' })).toMatchObject({ isError: false })
  })

  it('an agent with no repository (closed) gets a clear refusal for repo, never another project\'s memory', async () => {
    const { d } = setup()
    delete roots['kai']
    expect(await callTool(d, 'kai', 'memory_read', { scope: 'repo' })).toEqual({ text: 'Open a repository first', isError: true })
    roots['kai'] = '/projects/b'
  })
})

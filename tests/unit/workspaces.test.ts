import { describe, expect, it, vi } from 'vitest'
import { closeAgent, closeTerminals, type CloseDeps } from '../../src/main/application/closeTerminals'
import { endProject } from '../../src/main/application/switchProject'
import { GroupRegistry } from '../../src/main/application/groups'
import { Slots, spawnMany } from '../../src/main/application/spawnMany'
import { channels } from '../../src/shared/ipc/channels'
import { addSquad, cardNode, CARD_W, closableIds, flowEdges, hideOtherWorkspaces, inWorkspace, joinGroup, nextSlot, squadSpots, type AppNode, type SquadCreated } from '../../src/renderer/graph'

const created = (k: number): SquadCreated => {
  const a = (id: string, role: string) => ({ id, name: `N${id}`, role, branch: `agent/${role}-${k}`, model: 'default', state: 'idle' as const, statusUnavailable: false })
  const roles = ['frontend', 'backend', 'tester', 'reviewer'] as const
  return {
    squad: { id: `q${k}`, orchestratorId: `o${k}`, groupIds: roles.map((r) => `g${k}${r}`) },
    orchestrator: a(`o${k}`, 'orchestrator'),
    groups: roles.map((r) => ({ id: `g${k}${r}`, name: r, role: r, memberIds: [`${k}${r}1`, `${k}${r}2`] })),
    agents: roles.flatMap((r) => [a(`${k}${r}1`, r), a(`${k}${r}2`, r)]),
    edges: roles.map((r) => ({ id: `e${k}${r}`, workspaceId: 'w', source: { kind: 'group' as const, id: `g${k}${r}` }, target: { kind: 'squad' as const, id: `q${k}` }, template: 't', condition: '', paused: null, note: null })),
    failed: 0,
  }
}
const con = (id: string, ws: string, x = 24, status: 'running' | 'exited' = 'running') => cardNode(id, { ptyId: id, name: id, status, startedAt: 0, workspaceId: ws }, { x, y: 140 })

describe('workspaces on the board', () => {
  it('filters by workspace; undefined means every node', () => {
    const nodes: AppNode[] = [con('a', 'w1'), con('b', 'w2')]
    expect(inWorkspace(nodes, 'w2').map((n) => n.id)).toEqual(['b'])
    expect(inWorkspace(nodes)).toHaveLength(2)
  })
  it('finds the next free slot per workspace: an empty one starts at the origin whatever the others hold', () => {
    const nodes: AppNode[] = [con('a', 'w1'), con('b', 'w1', 24 + CARD_W + 24)]
    expect(nextSlot(inWorkspace(nodes, 'w2'), CARD_W)).toEqual({ x: 24, y: 140 })
    expect(nextSlot(inWorkspace(nodes, 'w1'), CARD_W).x).toBe(24 + 2 * (CARD_W + 24))
  })
  it('stacks, places and connects the squads of each workspace on their own', () => {
    const one = addSquad([], created(1), 0, 'w1')
    const two = addSquad(one, created(2), 0, 'w2')
    // the second workspace's first squad lands where an empty board puts it, not below the first workspace's
    expect(squadSpots(inWorkspace(one, 'w2'))).toEqual(squadSpots([]))
    expect(two.find((n) => n.id === 'q2')!.position).toEqual(one.find((n) => n.id === 'q1')!.position)
    // a second squad in w1 stacks below w1's first, ignoring w2
    const stacked = addSquad(two, created(3), 0, 'w1')
    expect(stacked.find((n) => n.id === 'q3')!.position.y).toBeGreaterThan(stacked.find((n) => n.id === 'q1')!.position.y)
    const all = [1, 2, 3].flatMap((k) => created(k).edges)
    const flags = { flowsPaused: false, firing: {}, lit: {} }
    expect(flowEdges(inWorkspace(stacked, 'w1'), all, flags)).toHaveLength(8)
    expect(flowEdges(inWorkspace(stacked, 'w2'), all, flags)).toHaveLength(4)
    expect(flowEdges(inWorkspace(stacked, 'w2'), all, flags).every((e) => String(e.target) === 'q2')).toBe(true)
    // every node of a squad, members and the hidden Orchestrator terminal included, carries the workspace
    expect(inWorkspace(two, 'w2').map((n) => n.id).sort()).toEqual(['2backend1', '2backend2', '2frontend1', '2frontend2', '2reviewer1', '2reviewer2', '2tester1', '2tester2', 'g2backend', 'g2frontend', 'g2reviewer', 'g2tester', 'o2', 'q2'].sort())
  })
  it('gives a new group its members\' workspace', () => {
    const nodes = joinGroup([con('a', 'w2'), con('b', 'w2')], { id: 'g', name: 'G' }, ['a', 'b'])
    expect(nodes.find((n) => n.id === 'g')!.data.workspaceId).toBe('w2')
  })
  it('hides, without unmounting, the nodes of the other workspaces', () => {
    const nodes: AppNode[] = [con('a', 'w1'), con('b', 'w2')]
    const [a, b] = hideOtherWorkspaces(nodes, 'w1')
    expect(a).toBe(nodes[0])
    expect(b).toMatchObject({ id: 'b', selectable: false, draggable: false, style: { visibility: 'hidden', pointerEvents: 'none' } })
    expect(b!.hidden).toBeUndefined() // `hidden` would unmount it
  })
  it('lists what main still knows: running consoles and every agent, not exited consoles', () => {
    const agent = cardNode('g', { ptyId: 'g', name: 'g', status: 'exited', startedAt: 0, agent: { role: 'r', model: 'm', branch: 'b', state: 'exited', statusUnavailable: false } }, { x: 0, y: 0 })
    expect(closableIds([con('a', 'w1'), con('dead', 'w1', 0, 'exited'), agent])).toEqual(['a', 'g'])
  })
})

describe('closeTerminals', () => {
  const setup = (opts: { agents?: string[]; consoles?: string[]; live?: string[]; outcome?: Record<string, string> } = {}) => {
    const agents = new Set(opts.agents ?? [])
    const consoles = new Set(opts.consoles ?? [])
    const d = {
      owns: vi.fn((o: number, id: string) => o === 1 && (agents.has(id) || consoles.has(id))),
      isAgent: vi.fn((_o: number, id: string) => agents.has(id)),
      needsConfirm: vi.fn((_o: number, id: string) => (opts.live ?? []).includes(id)),
      closeAgent: vi.fn((id: string) => Promise.resolve(opts.outcome?.[id] ?? 'removed')),
      killPty: vi.fn(() => Promise.resolve()),
      forget: vi.fn(),
    } satisfies CloseDeps
    return d
  }
  it('rejects the whole batch when an id is unknown or belongs to another window, closing nothing and asking nothing', async () => {
    const d = setup({ agents: ['a'], consoles: ['c'], live: ['a'] })
    const confirm = vi.fn(() => Promise.resolve(true))
    await expect(closeTerminals(d, 1, ['a', 'nope'], confirm)).rejects.toThrow('Unknown terminal')
    await expect(closeTerminals(d, 2, ['a', 'c'], confirm)).rejects.toThrow('Unknown terminal')
    expect(confirm).not.toHaveBeenCalled()
    expect(d.closeAgent).not.toHaveBeenCalled()
    expect(d.killPty).not.toHaveBeenCalled()
    expect(d.forget).not.toHaveBeenCalled()
  })
  it('asks once for the batch and closes every agent and console', async () => {
    const d = setup({ agents: ['a1', 'a2'], consoles: ['c'], live: ['a1', 'a2'] })
    const confirm = vi.fn(() => Promise.resolve(true))
    expect(await closeTerminals(d, 1, ['a1', 'c', 'a2', 'a1'], confirm)).toEqual({ closed: true, kept: 0, archived: 0 })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(d.closeAgent.mock.calls).toEqual([['a1'], ['a2']])
    expect(d.killPty.mock.calls).toEqual([['c']])
    expect(d.forget.mock.calls.map((c) => c[0])).toEqual(['a1', 'c', 'a2'])
  })
  it('closes nothing when the user keeps them running', async () => {
    const d = setup({ agents: ['a'], consoles: ['c'], live: ['a'] })
    expect(await closeTerminals(d, 1, ['a', 'c'], () => Promise.resolve(false))).toEqual({ closed: false, kept: 0, archived: 0 })
    expect(d.closeAgent).not.toHaveBeenCalled()
    expect(d.killPty).not.toHaveBeenCalled()
    expect(d.forget).not.toHaveBeenCalled()
  })
  it('does not ask when nothing is running, and still closes the rest when one close fails', async () => {
    const d = setup({ agents: ['a'], consoles: ['c'] })
    d.closeAgent.mockRejectedValueOnce(new Error('gone'))
    const confirm = vi.fn(() => Promise.resolve(false))
    expect(await closeTerminals(d, 1, ['a', 'c'], confirm)).toEqual({ closed: true, kept: 0, archived: 0 })
    expect(confirm).not.toHaveBeenCalled()
    expect(d.killPty).toHaveBeenCalledWith('c')
    expect(d.forget).toHaveBeenCalledTimes(2)
  })
  it('counts what the closed agents left behind, and takes more ids than the process limit (exited agents keep their card)', async () => {
    const ids = Array.from({ length: 30 }, (_v, i) => `a${i}`)
    const d = setup({ agents: ids, outcome: { a0: 'kept', a1: 'kept', a2: 'archived' } })
    expect(await closeTerminals(d, 1, ids, () => Promise.resolve(true))).toEqual({ closed: true, kept: 2, archived: 1 })
    const uuids = Array.from({ length: 30 }, () => crypto.randomUUID())
    expect(channels['workspace:closeTerminals'].in.safeParse({ ids: uuids }).success).toBe(true)
    expect(channels['workspace:closeTerminals'].in.safeParse({ ids: [] }).success).toBe(false)
    expect(channels['workspace:closeTerminals'].in.safeParse({ ids: Array.from({ length: 201 }, () => crypto.randomUUID()) }).success).toBe(false)
  })
})

describe('endProject (switching repository)', () => {
  const deps = (o: { starting?: boolean; ids?: string[]; closed?: boolean } = {}) => ({
    starting: () => o.starting ?? false,
    ownedIds: vi.fn(() => o.ids ?? ['a', 'b']),
    closeAll: vi.fn((ids: string[]) => Promise.resolve({ closed: o.closed ?? true, kept: ids.length, archived: 0 })),
  })
  it('refuses while a spawn is in flight, closing nothing', async () => {
    const d = deps({ starting: true })
    await expect(endProject(d)).rejects.toThrow('Wait for the agents to finish starting')
    expect(d.ownedIds).not.toHaveBeenCalled()
    expect(d.closeAll).not.toHaveBeenCalled()
  })
  it('closes everything main knows for the window and reports what was left', async () => {
    const d = deps({ ids: ['a', 'b', 'c'] })
    expect(await endProject(d)).toEqual({ changed: true, kept: 3, archived: 0 })
    expect(d.closeAll).toHaveBeenCalledWith(['a', 'b', 'c'])
  })
  it('does not switch when the user keeps them running; with nothing open it just switches', async () => {
    expect((await endProject(deps({ closed: false }))).changed).toBe(false)
    const empty = deps({ ids: [] })
    expect((await endProject(empty)).changed).toBe(true)
    expect(empty.closeAll).not.toHaveBeenCalled()
  })
})

describe('Spawn N per workspace', () => {
  it('gives the same preset an independent group in each workspace', async () => {
    let n = 0
    const groups = new GroupRegistry(() => true, () => `g${++n}`)
    const preset = { id: 'p1', name: 'Frontend', role: 'frontend', model: null, systemPrompt: '', adapter: 'claude' as const, builtin: true, createdAt: 1 }
    let a = 0
    const d = {
      presets: { get: () => preset },
      agents: { spawn: () => Promise.resolve({ id: `s${++a}`, name: `N${a}`, role: 'frontend', branch: 'b', model: 'default', state: 'idle' as const, statusUnavailable: false }) },
      groups,
      slots: new Slots(() => 0, 20),
    }
    const repo = { root: '/r', name: 'r', branch: 'main' }
    const r1 = await spawnMany(d, 1, repo, { presetId: 'p1', count: 2, cols: 80, rows: 24, workspaceId: 'w1' })
    const r2 = await spawnMany(d, 1, repo, { presetId: 'p1', count: 2, cols: 80, rows: 24, workspaceId: 'w2' })
    const r1b = await spawnMany(d, 1, repo, { presetId: 'p1', count: 1, cols: 80, rows: 24, workspaceId: 'w1' })
    expect(r2.group.id).not.toBe(r1.group.id)
    expect(r1b.group.id).toBe(r1.group.id)
    expect(r1b.group.memberIds).toHaveLength(3)
    expect(r2.group.memberIds).toHaveLength(2)
    groups.forget('s1') // closing cards of one workspace leaves the other's group alone
    expect(groups.findByPreset(1, 'p1', 'w2')?.memberIds).toHaveLength(2)
  })
})

describe('closing one agent (the agent:close handler)', () => {
  const run = async (o: { mine: boolean; outcome: 'removed' | 'cancelled' | Error }) => {
    let present = o.mine
    const forget = vi.fn()
    const r = closeAgent({
      has: () => present,
      close: async () => {
        if (o.outcome instanceof Error) {
          if (o.outcome.message === 'late') present = false // stopped, then the worktree step failed
          throw o.outcome
        }
        if (o.outcome !== 'cancelled') present = false
        return o.outcome
      },
      forget,
    })
    return { r: await r.catch((e: Error) => e.message), forget }
  }
  it('forgets group, squad and edges only once the agent is really gone', async () => {
    expect(await run({ mine: true, outcome: 'removed' })).toMatchObject({ r: 'removed' })
    expect((await run({ mine: true, outcome: 'removed' })).forget).toHaveBeenCalledOnce()
    expect((await run({ mine: true, outcome: 'cancelled' })).forget).not.toHaveBeenCalled() // the user kept it running
    expect((await run({ mine: false, outcome: new Error('Unknown agent') })).forget).not.toHaveBeenCalled() // another window's id
    expect((await run({ mine: true, outcome: new Error('early') })).forget).not.toHaveBeenCalled() // refused before stopping
    const late = await run({ mine: true, outcome: new Error('late') })
    expect(late.r).toBe('late')
    expect(late.forget).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { GroupRegistry } from '../../src/main/application/groups'
import { AGENT_BYTES, checkCapacity, RESERVE_BYTES, Slots, spawnMany } from '../../src/main/application/spawnMany'
import type { SpawnedAgent } from '../../src/main/application/agents'
import { MAX_LIVE } from '../../src/shared/agent'
import type { Repo } from '../../src/main/domain/agent'
import type { Preset } from '../../src/main/domain/preset'
import { CARD_H, CARD_W, groupSize, IN_GAP, joinGroup, layoutGroup, leaveGroup, memberPosition, membersOf, nextSlot, raiseOnly, removeCard, runningCount, setCollapsed, setPinned, type AppNode, type TerminalFlowNode } from '../../src/renderer/graph'

const registry = (owned: string[] = ['a', 'b', 'c', 'd']) => {
  let n = 0
  return new GroupRegistry((o, id) => o === 1 && owned.includes(id), () => `g${++n}`)
}

describe('GroupRegistry', () => {
  it('allows a card in at most one group', () => {
    const r = registry()
    r.create(1, 'G', ['a', 'b'])
    expect(() => r.create(1, 'H', ['b', 'c'])).toThrow('only be in one group')
    expect(() => r.create(1, 'H', ['c', 'c'])).toThrow('Duplicate')
    expect(() => r.addMembers(1, 'g1', ['a'])).toThrow('only be in one group')
    expect(r.addMembers(1, 'g1', ['c']).memberIds).toEqual(['a', 'b', 'c'])
  })
  it('checks ownership of cards and groups', () => {
    const r = registry()
    expect(() => r.create(2, 'G', ['a'])).toThrow('Unknown card')
    expect(() => r.create(1, 'G', ['zzz'])).toThrow('Unknown card')
    expect(() => r.create(1, 'G', [])).toThrow('at least one')
    r.create(1, 'G', ['a'])
    expect(() => r.dissolve(2, 'g1')).toThrow('Unknown group')
    expect(() => r.dissolve(1, 'nope')).toThrow('Unknown group')
  })
  it('removes a group that loses its last member, and frees dissolved members', () => {
    const r = registry()
    r.create(1, 'G', ['a', 'b'])
    r.forget('a')
    expect(r.size).toBe(1)
    r.forget('b')
    expect(r.size).toBe(0)
    r.create(1, 'H', ['a', 'b'])
    r.dissolve(1, 'g2')
    expect(r.groupOf('a')).toBeUndefined()
    r.create(1, 'I', ['a'])
    r.dropOwner(1)
    expect(r.size).toBe(0)
  })
})

const repo: Repo = { root: '/r', name: 'r', branch: 'main' }
const preset: Preset = { id: 'p1', name: 'Frontend', role: 'frontend', adapter: 'claude', model: 'opus', systemPrompt: 'sp', builtin: true, createdAt: 1 }

/** `live` holds the agents whose process runs; `exitAt` makes a process exit right after it started. */
function deps(failAt: number[] = [], free = MAX_LIVE, exitAt: number[] = []) {
  const live = new Set<string>()
  const groups = new GroupRegistry((o, id) => o === 1 && live.has(id), (() => { let n = 0; return () => `g${++n}` })())
  let i = 0
  const spawn = vi.fn(async (_o: number, _r: Repo | null, req: { role: string }): Promise<SpawnedAgent> => {
    await Promise.resolve() // a real spawn awaits git
    const n = ++i
    if (failAt.includes(n)) throw new Error('boom')
    if (!exitAt.includes(n)) live.add(`s${n}`)
    return { id: `s${n}`, name: `Zoe${n}`, role: req.role, branch: `agent/${req.role}-${n}`, model: 'opus', state: 'starting', statusUnavailable: false }
  })
  const slots = new Slots(() => MAX_LIVE - free + live.size, MAX_LIVE)
  return { d: { presets: { get: (x: string) => (x === 'p1' ? preset : undefined) }, agents: { spawn }, groups, slots }, spawn, groups, slots }
}

describe('Slots: what fits in memory', () => {
  it('counts free memory, the slots a batch holds and the terminals that just started', () => {
    let avail: number | null = RESERVE_BYTES + 3.5 * AGENT_BYTES
    let now = 0
    const s = new Slots(() => 0, MAX_LIVE, () => avail, () => now)
    expect(s.free()).toBe(3)
    expect(s.freeOfLimit()).toBe(MAX_LIVE)
    expect(() => s.reserve(4)).toThrow('Not enough free memory to start 4 more, there is room for 3. Close some terminals first')
    const r = s.reserve(2)
    expect(s.free()).toBe(1)
    r.use()
    r.use()
    expect(s.free()).toBe(1) // started, but the system does not show their memory yet
    now = 31_000
    expect(s.free()).toBe(3)
    avail = RESERVE_BYTES / 2
    expect(s.free()).toBeLessThan(1)
    expect(() => s.reserve(0)).not.toThrow() // nothing to start is never a refusal
    s.reserve(1, true).use(false) // a console, already granted: neither checked nor counted as memory
    avail = RESERVE_BYTES + 3.5 * AGENT_BYTES
    expect(s.free()).toBe(3)
    avail = null // the system does not say: only the limit counts
    expect(s.free()).toBe(MAX_LIVE)
  })
})

describe('checkCapacity / spawnMany', () => {
  it('refuses before creating anything when there are not enough slots', async () => {
    expect(() => checkCapacity(3, 4, MAX_LIVE)).toThrow(`Only 3 of ${MAX_LIVE} terminals are free, cannot start 4`)
    expect(() => checkCapacity(4, 4, MAX_LIVE)).not.toThrow()
    const { d, spawn, groups } = deps([], 3)
    await expect(spawnMany(d, 1, repo, { presetId: 'p1', count: 4, cols: 80, rows: 24 })).rejects.toThrow('cannot start 4')
    expect(spawn).not.toHaveBeenCalled()
    expect(groups.size).toBe(0)
  })
  it('needs a repository and a known preset', async () => {
    const { d } = deps()
    await expect(spawnMany(d, 1, null, { presetId: 'p1', count: 1, cols: 80, rows: 24 })).rejects.toThrow('Open a repository')
    await expect(spawnMany(d, 1, repo, { presetId: 'zz', count: 1, cols: 80, rows: 24 })).rejects.toThrow('Unknown preset')
  })
  it('spawns N with the preset options into one group named after the preset', async () => {
    const { d, spawn } = deps()
    const r = await spawnMany(d, 1, repo, { presetId: 'p1', count: 4, cols: 80, rows: 24 })
    expect(r.agents.map((a) => a.name)).toEqual(['Zoe1', 'Zoe2', 'Zoe3', 'Zoe4'])
    expect(r.group).toEqual({ id: 'g1', name: 'Frontend', memberIds: ['s1', 's2', 's3', 's4'] })
    expect(r.failed).toBe(0)
    expect(spawn).toHaveBeenCalledWith(1, repo, { role: 'frontend', model: 'opus', systemPrompt: 'sp', cols: 80, rows: 24, presetId: 'p1' })
  })
  it('keeps the agents that started and counts the failures', async () => {
    const { d } = deps([2, 4])
    const r = await spawnMany(d, 1, repo, { presetId: 'p1', count: 4, cols: 80, rows: 24 })
    expect(r.agents.map((a) => a.id)).toEqual(['s1', 's3'])
    expect(r.failed).toBe(2)
    expect(r.group.memberIds).toEqual(['s1', 's3'])
  })
  it('throws when none started, and reuses the preset group on the next spawn', async () => {
    await expect(spawnMany(deps([1, 2]).d, 1, repo, { presetId: 'p1', count: 2, cols: 80, rows: 24 })).rejects.toThrow('boom')
    const { d } = deps()
    const a = await spawnMany(d, 1, repo, { presetId: 'p1', count: 2, cols: 80, rows: 24 })
    const b = await spawnMany(d, 1, repo, { presetId: 'p1', count: 2, cols: 80, rows: 24 })
    expect(b.group.id).toBe(a.group.id)
    expect(b.group.memberIds).toEqual(['s1', 's2', 's3', 's4'])
  })
  it('still returns the group when a process exits during the batch (its card shows it, closable)', async () => {
    const { d, groups } = deps([], MAX_LIVE, [1, 3])
    const r = await spawnMany(d, 1, repo, { presetId: 'p1', count: 3, cols: 80, rows: 24 })
    expect(r.group.memberIds).toEqual(['s1', 's2', 's3'])
    expect(groups.groupOf('s1')?.id).toBe(r.group.id)
    const more = await spawnMany(d, 1, repo, { presetId: 'p1', count: 1, cols: 80, rows: 24 })
    expect(more.group.memberIds).toEqual(['s1', 's2', 's3', 's4'])
  })
  it('reserves the slots of a running batch: a concurrent one that does not fit is refused before spawning', async () => {
    const { d, spawn, slots } = deps([], 10)
    const first = spawnMany(d, 1, repo, { presetId: 'p1', count: 6, cols: 80, rows: 24 })
    await expect(spawnMany(d, 1, repo, { presetId: 'p1', count: 6, cols: 80, rows: 24 })).rejects.toThrow(`Only 4 of ${MAX_LIVE} terminals are free, cannot start 6`)
    expect((await first).agents).toHaveLength(6)
    expect(spawn).toHaveBeenCalledTimes(6)
    expect(slots.free()).toBe(4) // the reservation is gone once the batch ends
  })
  it('gives the reservation back when a batch fails', async () => {
    const { d, slots } = deps([1, 2], 10)
    await expect(spawnMany(d, 1, repo, { presetId: 'p1', count: 2, cols: 80, rows: 24 })).rejects.toThrow('boom')
    expect(slots.free()).toBe(10)
  })
})

const term = (id: string, x = 0, y = 0, extra: Partial<TerminalFlowNode> = {}, status: 'running' | 'exited' = 'running'): TerminalFlowNode => ({
  id, type: 'terminal', position: { x, y }, style: { width: CARD_W, height: CARD_H }, data: { ptyId: id, name: id, status, startedAt: 0 }, ...extra,
})

describe('group graph mapping', () => {
  it('lays members out in a single row', () => {
    expect(memberPosition(0)).toEqual({ x: 12, y: 12 })
    expect(memberPosition(1)).toEqual({ x: 12 + CARD_W + IN_GAP, y: 12 })
    expect(memberPosition(3)).toEqual({ x: 12 + 3 * (CARD_W + IN_GAP), y: 12 })
    expect(groupSize(1, false)).toEqual({ width: 24 + CARD_W, height: 24 + CARD_H })
    expect(groupSize(4, false)).toEqual({ width: 24 + 4 * CARD_W + 3 * IN_GAP, height: 24 + CARD_H })
    expect(groupSize(3, false).height).toBe(groupSize(4, false).height)
    expect(groupSize(4, true).height).toBeLessThan(20)
  })
  it('puts cards under a parent group node that comes first', () => {
    const nodes = joinGroup([term('x', 500, 500), term('a'), term('b')], { id: 'g', name: 'G' }, ['a', 'b'], { x: 50, y: 60 })
    expect(nodes.map((n) => n.id)).toEqual(['x', 'g', 'a', 'b'])
    const g = nodes.find((n) => n.id === 'g')!
    expect(g).toMatchObject({ type: 'group', position: { x: 50, y: 60 }, data: { name: 'G', collapsed: false }, selectable: false })
    expect(membersOf(nodes, 'g').map((m) => [m.id, m.position, m.draggable])).toEqual([['a', memberPosition(0), false], ['b', memberPosition(1), false]])
    expect(nodes.find((n) => n.id === 'x')!.parentId).toBeUndefined()
  })
  it('wraps a new group around cards that were already placed', () => {
    const nodes = joinGroup([term('a', 100, 200), term('b', 600, 300)], { id: 'g', name: 'G' }, ['a', 'b'])
    expect(nodes.find((n) => n.id === 'g')!.position).toEqual({ x: 88, y: 188 })
  })
  it('adds to an existing group and re-lays out', () => {
    const first = joinGroup([term('a'), term('b')], { id: 'g', name: 'G' }, ['a', 'b'], { x: 0, y: 0 })
    const more = joinGroup([...first, term('c'), term('d')], { id: 'g', name: 'G' }, ['c', 'd'])
    expect(membersOf(more, 'g').map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(more.find((n) => n.id === 'g')!.style).toMatchObject(groupSize(4, false))
    expect(more.filter((n) => n.type === 'group')).toHaveLength(1)
  })
  it('counts running members only', () => {
    const nodes = joinGroup([term('a'), term('b', 0, 0, {}, 'exited'), term('c')], { id: 'g', name: 'G' }, ['a', 'b', 'c'], { x: 0, y: 0 })
    expect(runningCount(nodes, 'g')).toBe(2)
    const dead = nodes.map((n): AppNode => (n.id === 'c' && n.type === 'terminal' ? { ...n, data: { ...n.data, agent: { role: 'r', model: 'm', branch: 'b', state: 'error', statusUnavailable: false } } } : n))
    expect(runningCount(dead, 'g')).toBe(1)
  })
  it('collapses to a strip keeping members mounted but hidden, and expands back', () => {
    let nodes = joinGroup([term('a'), term('b')], { id: 'g', name: 'G' }, ['a', 'b'], { x: 0, y: 0 })
    nodes = setCollapsed(nodes, 'g', true)
    expect(nodes.find((n) => n.id === 'g')!.style).toMatchObject({ height: groupSize(2, true).height })
    expect(membersOf(nodes, 'g')).toHaveLength(2)
    for (const m of membersOf(nodes, 'g')) expect(m.style).toMatchObject({ visibility: 'hidden', pointerEvents: 'none' })
    nodes = setCollapsed(nodes, 'g', false)
    for (const m of membersOf(nodes, 'g')) expect(m.style).toEqual({ width: CARD_W, height: CARD_H, pointerEvents: 'all' })
  })
  it('removes a closed member, re-lays out, and drops the group with its last member', () => {
    let nodes = joinGroup([term('a'), term('b'), term('c')], { id: 'g', name: 'G' }, ['a', 'b', 'c'], { x: 0, y: 0 })
    nodes = removeCard(nodes, 'a')
    expect(membersOf(nodes, 'g').map((m) => [m.id, m.position])).toEqual([['b', memberPosition(0)], ['c', memberPosition(1)]])
    nodes = removeCard(removeCard(nodes, 'b'), 'c')
    expect(nodes).toEqual([])
  })
  it('ungroups in place', () => {
    let nodes = joinGroup([term('a'), term('b')], { id: 'g', name: 'G' }, ['a', 'b'], { x: 100, y: 200 })
    nodes = leaveGroup(nodes, 'g')
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(nodes[1]).toMatchObject({ position: { x: 100 + 12 + CARD_W + IN_GAP, y: 212 } })
    expect(nodes[0]!.parentId).toBeUndefined()
    expect(nodes[0]!.draggable).toBeUndefined()
    expect(layoutGroup(nodes, 'g')).toBe(nodes)
  })
  it('places new top-level nodes to the right, then on a new row', () => {
    expect(nextSlot([], CARD_W)).toEqual({ x: 24, y: 140 })
    const one = [term('a', 24, 140)]
    expect(nextSlot(one, CARD_W)).toEqual({ x: 24 + CARD_W + 24, y: 140 })
    const three = [term('a', 24, 140), term('b', 488, 140), term('c', 952, 140)]
    expect(nextSlot(three, CARD_W)).toEqual({ x: 24, y: 140 + CARD_H + 48 })
  })
})

describe('pin and maximize', () => {
  it('a pinned free card cannot be dragged and can be unpinned', () => {
    const pinned = setPinned([term('a'), term('b')], 'a', true)
    expect(pinned[0]).toMatchObject({ draggable: false, data: { pinned: true } })
    expect(pinned[1]!.draggable).toBeUndefined()
    const free = setPinned(pinned, 'a', false)
    expect(free[0]!.draggable).toBeUndefined()
    expect((free[0] as TerminalFlowNode).data.pinned).toBe(false)
  })
  it('leaves grouped cards to their group, and a pinned card stays locked after leaving a group', () => {
    const grouped = joinGroup([term('a'), term('b')], { id: 'g', name: 'G' }, ['a', 'b'], { x: 0, y: 0 })
    expect((setPinned(grouped, 'a', true).find((n) => n.id === 'a') as TerminalFlowNode).data.pinned).toBeUndefined()
    const pre = setPinned([term('a'), term('b')], 'a', true)
    const out = leaveGroup(joinGroup(pre, { id: 'g', name: 'G' }, ['a', 'b'], { x: 0, y: 0 }), 'g')
    expect(out.find((n) => n.id === 'a')!.draggable).toBe(false)
    expect(out.find((n) => n.id === 'b')!.draggable).toBeUndefined()
  })
  it('raises only the maximized card', () => {
    const up = raiseOnly([term('a'), term('b')], 'a')
    expect(up[0]!.zIndex).toBe(1000)
    expect(up[1]!.zIndex).toBeUndefined()
    expect(raiseOnly(up, null).every((n) => n.zIndex === undefined)).toBe(true)
  })
})

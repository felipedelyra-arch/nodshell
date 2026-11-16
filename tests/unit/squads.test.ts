import { describe, expect, it, vi } from 'vitest'
import type { SpawnedAgent } from '../../src/main/application/agents'
import { createSquad } from '../../src/main/application/createSquad'
import { Slots, spawnMany } from '../../src/main/application/spawnMany'
import { GroupRegistry } from '../../src/main/application/groups'
import { SquadRegistry } from '../../src/main/application/squads'
import type { Repo } from '../../src/main/domain/agent'
import { BUILTIN_PRESETS, type Preset } from '../../src/main/domain/preset'
import { MAX_LIVE } from '../../src/shared/agent'
import { addSpawned, addSquad, cardNode, destinations, endpointOf, flowEdges, isGroup, isOrchestrator, leaveGroup, membersOf, ORCH_BAND, ORCH_W, removeCard, SQUAD_COL_GAP, SQUAD_HANDLES, squadSpots, setCollapsed, type AppNode, type FlowEdgeDto, type SourceEnd, type SquadCreated, type TargetEnd } from '../../src/renderer/graph'

describe('SquadRegistry', () => {
  it('keeps a squad until its Orchestrator closes (members do not), per owner', () => {
    let n = 0
    const r = new SquadRegistry(() => `q${++n}`)
    expect(r.create(1, 'o1', ['g1', 'g2'])).toEqual({ id: 'q1', ownerId: 1, orchestratorId: 'o1', groupIds: ['g1', 'g2'], extraIds: [] })
    expect(r.forget('g1')).toBeUndefined()
    expect(r.forget('member')).toBeUndefined()
    expect(r.forget('o1')?.id).toBe('q1')
    expect(r.forget('o1')).toBeUndefined()
    r.create(1, 'o2', [])
    r.create(2, 'o3', [])
    r.dropOwner(2) // another window's squads only
    expect(r.forget('o3')).toBeUndefined()
    expect(r.forget('o2')?.ownerId).toBe(1)
  })
  it('counts the extras spawn_agent added until they close; a new group joins the squad once', () => {
    const r = new SquadRegistry(() => 'q1')
    const s = r.create(1, 'o1', ['g1'])
    r.addExtra(s, 'x1', 'g1')
    r.addExtra(s, 'x2', 'g2')
    r.addExtra(s, 'x3', 'g2')
    expect(s).toMatchObject({ groupIds: ['g1', 'g2'], extraIds: ['x1', 'x2', 'x3'] })
    expect(r.forget('x2')).toBeUndefined() // an extra closing never ends the squad
    expect(s.extraIds).toEqual(['x1', 'x3'])
  })
})

const repo: Repo = { root: '/r', name: 'r', branch: 'main' }
const presets: Preset[] = BUILTIN_PRESETS.map((p, i) => ({ ...p, model: null, id: `p${i}`, adapter: 'claude', builtin: true, createdAt: 1 }))

/** `live` holds the agents whose process runs; `exit` makes a process exit right after it started. */
function deps(opts: { fail?: (n: number, role: string) => boolean; exit?: (n: number) => boolean; free?: number; list?: Preset[] } = {}) {
  const live = new Set<string>()
  const groups = new GroupRegistry((o, id) => o === 1 && live.has(id), (() => { let n = 0; return () => `g${++n}` })())
  const squads = new SquadRegistry((() => { let n = 0; return () => `q${++n}` })())
  let i = 0
  const spawn = vi.fn(async (_o: number, _r: Repo | null, req: { role: string }): Promise<SpawnedAgent> => {
    await Promise.resolve() // a real spawn awaits git
    const n = ++i
    if (opts.fail?.(n, req.role)) throw new Error('boom')
    if (!opts.exit?.(n)) live.add(`a${n}`)
    return { id: `a${n}`, name: `Zoe${n}`, role: req.role, branch: `agent/${req.role}-${n}`, model: 'default', state: 'starting', statusUnavailable: false }
  })
  const slots = new Slots(() => MAX_LIVE - (opts.free ?? MAX_LIVE) + live.size, MAX_LIVE)
  let e = 0
  const flow = { create: vi.fn((ownerId: number, source: SourceEnd, target: TargetEnd) => ({ id: `e${++e}`, ownerId, workspaceId: 'w', source, target, template: 't', condition: '', paused: null, note: null })) }
  const d = { presets: { list: () => opts.list ?? presets }, agents: { spawn }, groups, squads, slots, flow }
  return { d, spawn, groups, squads, slots, flow }
}

describe('createSquad', () => {
  it('starts an Orchestrator and four groups of two in the squad roles', async () => {
    const { d, spawn, groups, squads } = deps()
    const r = await createSquad(d, 1, repo, { cols: 80, rows: 24 })
    expect(spawn).toHaveBeenCalledTimes(9)
    expect(spawn.mock.calls.map((c) => c[2].role)).toEqual(['orchestrator', 'frontend', 'frontend', 'backend', 'backend', 'tester', 'tester', 'reviewer', 'reviewer'])
    expect(spawn.mock.calls[0]![2]).toMatchObject({ systemPrompt: expect.stringMatching(/^You are the orchestrator/) })
    expect(r.orchestrator.role).toBe('orchestrator')
    expect(r.groups.map((g) => [g.role, g.name, g.memberIds.length])).toEqual([['frontend', 'Frontend', 2], ['backend', 'Backend', 2], ['tester', 'Testers', 2], ['reviewer', 'Reviewers', 2]])
    expect(r.agents).toHaveLength(8)
    expect(r.failed).toBe(0)
    expect(r.squad).toEqual({ id: 'q1', orchestratorId: r.orchestrator.id, groupIds: r.groups.map((g) => g.id) })
    // one active edge per group to the Orchestrator, created in main and returned
    expect(r.edges.map((e) => [e.source, e.target])).toEqual(r.groups.map((g) => [{ kind: 'group', id: g.id }, { kind: 'squad', id: 'q1' }]))
    expect(groups.size).toBe(4)
    expect(squads.forget(r.orchestrator.id)?.id).toBe('q1')
    // each squad group is its preset's group: Spawn N of that preset adds agents to it
    for (const g of r.groups) expect(groups.findByPreset(1, presets.find((p) => p.name === g.name)!.id)?.id).toBe(g.id)
  })
  it('a small squad starts one agent per group, and Spawn N of a role preset joins that group', async () => {
    const { d, spawn, groups } = deps({ free: 5 })
    const r = await createSquad(d, 1, repo, { cols: 80, rows: 24 }, 1)
    expect(spawn).toHaveBeenCalledTimes(5)
    expect(r.groups.map((g) => g.memberIds.length)).toEqual([1, 1, 1, 1])
    expect([r.agents.length, r.failed, r.edges.length]).toEqual([4, 0, 4])
    const front = presets.find((p) => p.role === 'frontend')!
    const { d: roomy } = deps()
    const more = await spawnMany({ presets: { get: () => front }, agents: roomy.agents, groups: d.groups, slots: roomy.slots }, 1, repo, { presetId: front.id, count: 1, cols: 80, rows: 24 })
    expect(more.group.id).toBe(r.groups[0]!.id)
    expect(more.group.memberIds).toHaveLength(2)
    expect(groups.size).toBe(4)
  })
  it('refuses without room for nine before creating anything', async () => {
    const { d, spawn, groups } = deps({ free: 8 })
    await expect(createSquad(d, 1, repo, { cols: 80, rows: 24 })).rejects.toThrow(`Only 8 of ${MAX_LIVE} terminals are free, cannot start 9`)
    expect(spawn).not.toHaveBeenCalled()
    expect(groups.size).toBe(0)
  })
  it('reserves its nine slots: a concurrent squad or Spawn N that does not fit is refused before spawning', async () => {
    const { d, spawn, slots } = deps({ free: 17 })
    const first = createSquad(d, 1, repo, { cols: 80, rows: 24 })
    await expect(createSquad(d, 1, repo, { cols: 80, rows: 24 })).rejects.toThrow(`Only 8 of ${MAX_LIVE} terminals are free, cannot start 9`)
    const many = { presets: { get: () => presets[0] }, agents: d.agents, groups: d.groups, slots: d.slots }
    await expect(spawnMany(many, 1, repo, { presetId: 'p0', count: 9, cols: 80, rows: 24 })).rejects.toThrow('cannot start 9')
    expect((await first).agents).toHaveLength(8)
    expect(spawn).toHaveBeenCalledTimes(9)
    expect(slots.free()).toBe(8)
  })
  it('returns the squad even when processes exit during the batch, the Orchestrator included', async () => {
    const { d, groups } = deps({ exit: (n) => n === 1 || n === 4 })
    const r = await createSquad(d, 1, repo, { cols: 80, rows: 24 })
    expect(r.squad.orchestratorId).toBe('a1')
    expect(r.groups.map((g) => g.memberIds.length)).toEqual([2, 2, 2, 2])
    expect(groups.size).toBe(4)
  })
  it('needs a repository and the built-in presets', async () => {
    await expect(createSquad(deps().d, 1, null, { cols: 80, rows: 24 })).rejects.toThrow('Open a repository')
    const { d, spawn } = deps({ list: presets.filter((p) => p.role !== 'tester') })
    await expect(createSquad(d, 1, repo, { cols: 80, rows: 24 })).rejects.toThrow('presets for a squad are missing')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('creates nothing else when the Orchestrator fails', async () => {
    const { d, spawn, groups, squads } = deps({ fail: (_n, role) => role === 'orchestrator' })
    await expect(createSquad(d, 1, repo, { cols: 80, rows: 24 })).rejects.toThrow('boom')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(groups.size).toBe(0)
    expect(squads.forget('a1')).toBeUndefined()
  })
  it('keeps the agents that started, skips a group with none, and counts failures', async () => {
    const { d } = deps({ fail: (n, role) => role === 'backend' || n === 6 })
    const r = await createSquad(d, 1, repo, { cols: 80, rows: 24 })
    expect(r.groups.map((g) => [g.role, g.memberIds.length])).toEqual([['frontend', 2], ['tester', 1], ['reviewer', 2]])
    expect(r.failed).toBe(3)
    expect(r.squad.groupIds).toHaveLength(3)
  })
})

const dto = (id: string, source: SourceEnd, target: TargetEnd, paused: string | null = null): FlowEdgeDto => ({ id, workspaceId: 'w', source, target, template: 't', condition: '', paused, note: null })
const flags = { flowsPaused: false, firing: {}, lit: {} }
const created = (k: number): SquadCreated => {
  const a = (id: string, role: string) => ({ id, name: `N${id}`, role, branch: `agent/${role}-${k}`, model: 'default', state: 'idle' as const, statusUnavailable: false })
  const roles = ['frontend', 'backend', 'tester', 'reviewer'] as const
  return {
    squad: { id: `q${k}`, orchestratorId: `o${k}`, groupIds: roles.map((r) => `g${k}${r}`) },
    orchestrator: a(`o${k}`, 'orchestrator'),
    groups: roles.map((r) => ({ id: `g${k}${r}`, name: r, role: r, memberIds: [`${k}${r}1`, `${k}${r}2`] })),
    agents: roles.flatMap((r) => [a(`${k}${r}1`, r), a(`${k}${r}2`, r)]),
    edges: roles.map((r) => dto(`e${k}${r}`, { kind: 'group', id: `g${k}${r}` }, { kind: 'squad', id: `q${k}` })),
    failed: 0,
  }
}
type Box = { x: number; y: number; w: number; h: number }
const boxOf = (n: AppNode): Box => ({ x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) })
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const centreOf = (nodes: AppNode[], id: string) => {
  const n = nodes.find((x) => x.id === id)!
  return n.position.x + Number(n.style?.width) / 2
}
const top = (nodes: AppNode[], k: number) => nodes.filter((n) => !n.parentId && (n.id === `q${k}` || n.id.startsWith(`g${k}`))).map(boxOf)

describe('squad layout', () => {
  it('spawn_agent: a card joins its group in the single row; a group left of the Orchestrator grows leftwards; a new group takes its spot', () => {
    let nodes = addSquad([], created(1), 0, 'w')
    const panel = nodes.find(isOrchestrator)!
    const fe = (ns: AppNode[]) => ns.find((n) => n.id === 'g1frontend')!
    const right = (n: AppNode) => n.position.x + Number(n.style?.width)
    const before = boxOf(fe(nodes))
    const agent = (id: string, role: string) => ({ id, name: 'Uma', role, branch: `agent/${role}-3`, model: 'default', state: 'starting' as const, statusUnavailable: false })
    nodes = addSpawned(nodes, { squadId: 'q1', group: { id: 'g1frontend', name: 'frontend', role: 'frontend', created: false }, agent: agent('x1', 'frontend') }, 0)
    expect(membersOf(nodes, 'g1frontend').map((m) => [m.id, m.position.y])).toEqual([['1frontend1', 12], ['1frontend2', 12], ['x1', 12]]) // one row
    expect(right(fe(nodes))).toBe(before.x + before.w) // the side facing the Orchestrator stays
    expect(boxOf(fe(nodes)).w).toBeGreaterThan(before.w)
    const be = nodes.find((n) => n.id === 'g1backend')!
    nodes = addSpawned(nodes, { squadId: 'q1', group: { id: 'g1backend', name: 'backend', role: 'backend', created: false }, agent: agent('x2', 'backend') }, 0)
    expect(nodes.find((n) => n.id === 'g1backend')!.position).toEqual(be.position) // right of it: grows rightwards
    // new groups: a squad role at its place beside the Orchestrator, another role at the next free spot; both become sections
    const lone = addSquad([], { ...created(2), groups: created(2).groups.filter((g) => g.role !== 'tester'), squad: { ...created(2).squad, groupIds: created(2).squad.groupIds.filter((g) => !g.endsWith('tester')) } }, 0, 'w')
    const p2 = lone.find(isOrchestrator)!
    let grown = addSpawned(lone, { squadId: 'q2', group: { id: 'gt', name: 'Testers', role: 'tester', created: true }, agent: agent('x3', 'tester') }, 0)
    const gt = grown.find((n) => n.id === 'gt')!
    expect(right(gt)).toBe(p2.position.x - SQUAD_COL_GAP)
    expect(gt.position.y).toBeGreaterThan(p2.position.y)
    grown = addSpawned(grown, { squadId: 'q2', group: { id: 'gd', name: 'Docs', role: 'docs', created: true }, agent: agent('x4', 'docs') }, 0)
    const panel2 = grown.find(isOrchestrator)!
    expect(panel2.data.groups.map((g) => g.role)).toEqual(['backend', 'reviewer', 'frontend', 'tester', 'docs'])
    for (const a of top(grown, 2)) for (const b of grown.filter((n) => n.id === 'gd').map(boxOf)) expect(overlap(a, b)).toBe(false)
    // its edge leaves the side facing the Orchestrator
    const [e] = flowEdges(grown, [dto('e', { kind: 'group', id: 'gd' }, { kind: 'squad', id: 'q2' })], flags)
    expect(e!.sourceHandle).toBe(centreOf(grown, 'gd') < centreOf(grown, 'q2') ? 'r' : 'l')
    // no squad on the board: a loose card in the given workspace
    const loose = addSpawned(nodes, { squadId: null, group: null, agent: agent('x5', 'docs') }, 0, 'w')
    expect(loose.find((n) => n.id === 'x5')).toMatchObject({ data: { workspaceId: 'w' } })
    expect(loose.find((n) => n.id === 'x5')!.parentId).toBeUndefined()
    expect(panel.data.groups).toHaveLength(4)
  })

  it('spawn_agent: a new group never lands on loose cards standing on its role\'s place (a group the user dissolved)', () => {
    const agent = { id: 'x1', name: 'Uma', role: 'tester', branch: 'agent/tester-3', model: 'default', state: 'starting' as const, statusUnavailable: false }
    const nodes = leaveGroup(addSquad([], created(1), 0, 'w'), 'g1tester')
    const loose = nodes.filter((n) => n.id.startsWith('1tester')).map(boxOf)
    expect(loose).toHaveLength(2)
    const next = addSpawned(nodes, { squadId: 'q1', group: { id: 'gt', name: 'Testers', role: 'tester', created: true }, agent }, 0)
    const frame = boxOf(next.find((n) => n.id === 'gt')!)
    for (const b of [...loose, ...top(next, 1)]) expect(overlap(frame, b)).toBe(false)
    // with its place free, it goes there
    const free = addSpawned(addSquad([], { ...created(2), groups: created(2).groups.filter((g) => g.role !== 'tester'), agents: created(2).agents.filter((a) => a.role !== 'tester') }, 0, 'w'), { squadId: 'q2', group: { id: 'gt', name: 'Testers', role: 'tester', created: true }, agent }, 0)
    const p = free.find(isOrchestrator)!
    expect(boxOf(free.find((n) => n.id === 'gt')!).x + boxOf(free.find((n) => n.id === 'gt')!).w).toBe(p.position.x - SQUAD_COL_GAP)
  })

  it('puts Frontend and Testers left, Backend and Reviewers right, the Orchestrator between both rows', () => {
    const s = squadSpots([])
    const nodes = addSquad([], created(1), 0)
    const g = (role: string) => boxOf(nodes.find((n) => n.id === `g1${role}`)!)
    expect(g('frontend').x).toBe(s.frontend.x)
    expect(g('frontend').x).toBe(g('tester').x)
    expect(g('backend').x).toBe(g('reviewer').x)
    expect(g('frontend').y).toBe(g('backend').y)
    expect(g('tester').y).toBeGreaterThan(g('frontend').y + g('frontend').h)
    expect(g('reviewer').y).toBe(g('tester').y)
    const o = boxOf(nodes.find(isOrchestrator)!)
    // a band spanning both rows exactly; the panel is centred in it by CSS
    expect([o.w, o.h]).toEqual([ORCH_W, ORCH_BAND])
    expect(o.y).toBe(g('frontend').y)
    expect(o.y + o.h).toBe(g('tester').y + g('tester').h)
    expect(o.x).toBeGreaterThan(g('frontend').x + g('frontend').w)
    expect(o.x + o.w).toBeLessThan(g('backend').x)
    const mid = o.y + o.h / 2
    expect(mid).toBeGreaterThan(g('frontend').y + g('frontend').h / 2)
    expect(mid).toBeLessThan(g('tester').y + g('tester').h / 2)
    expect(Math.abs(mid - (g('frontend').y + g('tester').y + g('tester').h) / 2)).toBeLessThan(1)
    // 4 groups of 2, the Orchestrator's terminal hidden inside its node; sections in display order
    expect(nodes.filter(isGroup).map((n) => membersOf(nodes, n.id).length)).toEqual([2, 2, 2, 2])
    const term = nodes.find((n) => n.id === 'o1')!
    expect(term.parentId).toBe('q1')
    expect(term.style).toMatchObject({ visibility: 'hidden', pointerEvents: 'none' })
    expect(nodes.find(isOrchestrator)!.data.groups.map((x) => x.id)).toEqual(['g1backend', 'g1reviewer', 'g1frontend', 'g1tester'])
    expect(nodes.find(isOrchestrator)!.style).toMatchObject({ pointerEvents: 'none' })
    // closing the Orchestrator drops its node; the groups stay
    const after = removeCard(nodes, 'o1')
    expect(after.some(isOrchestrator)).toBe(false)
    expect(after.filter(isGroup)).toHaveLength(4)
  })
  it('stacks a second squad below the first with a free gap, without moving loose nodes or overlapping', () => {
    const loose = cardNode('c', { ptyId: 'c', name: 'console-1', status: 'running', startedAt: 0 }, { x: 900, y: 140 })
    const one = addSquad([loose], created(1), 0)
    const two = addSquad(one, created(2), 0)
    expect(two.find((n) => n.id === 'c')!.position).toEqual({ x: 900, y: 140 })
    const first = top(two, 1)
    const second = top(two, 2)
    const bottom = Math.max(...first.map((b) => b.y + b.h))
    for (const b of second) expect(b.y).toBeGreaterThanOrEqual(bottom + 200)
    expect(Math.min(...second.map((b) => b.x))).toBe(Math.min(...first.map((b) => b.x)))
    const all = [...first, ...second, boxOf(loose)]
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!)).toBe(false)
  })
  it('draws main\'s edges: a squad group from the side facing the Orchestrator, upper row higher; only while both ends are on the board', () => {
    const nodes = addSquad([cardNode('c', { ptyId: 'c', name: 'console-1', status: 'running', startedAt: 0 }, { x: 0, y: 0 })], created(1), 0)
    const all = created(1).edges
    const edges = flowEdges(nodes, all, flags)
    expect(edges.map((e) => [e.source, e.target, e.sourceHandle, e.targetHandle, e.type])).toEqual(
      (['frontend', 'backend', 'tester', 'reviewer'] as const).map((r) => [`g1${r}`, 'q1', SQUAD_HANDLES[r].source, SQUAD_HANDLES[r].target, 'flow']),
    )
    expect(SQUAD_HANDLES.frontend.source).toBe('r-lo') // left column leaves from the right side
    expect(SQUAD_HANDLES.backend.source).toMatch(/^l-/)
    expect(new Set(edges.map((e) => e.targetHandle)).size).toBe(4) // four distinct arrival points
    for (const e of edges) expect(e).toMatchObject({ selectable: false, focusable: false, deletable: false, domAttributes: { 'aria-hidden': true } })
    expect(edges[0]!.data).toMatchObject({ label: 'FRONTEND to Orchestrator', paused: false, firing: false, lit: false })
    expect(flowEdges(setCollapsed(nodes, 'g1tester', true), all, flags)).toHaveLength(4) // a collapsed group keeps its edge
    expect(flowEdges(leaveGroup(nodes, 'g1tester'), all, flags).map((e) => e.source)).not.toContain('g1tester')
    expect(flowEdges(removeCard(removeCard(nodes, '1reviewer1'), '1reviewer2'), all, flags)).toHaveLength(3)
    expect(flowEdges(removeCard(nodes, 'o1'), all, flags)).toEqual([])
    // paused (by itself or every flow), firing and lit come from the store
    const paused = flowEdges(nodes, [dto('x', { kind: 'group', id: 'g1frontend' }, { kind: 'squad', id: 'q1' }, 'Loop detected')], { flowsPaused: false, firing: { x: 1 }, lit: { x: 1 } })
    expect(paused[0]!.data).toMatchObject({ paused: true, firing: true, lit: true })
    expect(flowEdges(nodes, all, { ...flags, flowsPaused: true }).every((e) => e.data!.paused)).toBe(true)
  })
  it('an agent edge leaves the side facing its target; ends, consoles and the docked Orchestrator', () => {
    const nodes = addSquad([cardNode('c', { ptyId: 'c', name: 'console-1', status: 'running', startedAt: 0 }, { x: 0, y: 0 })], created(1), 0)
    // a frontend card (left column) to a backend card (right column), and back
    const there = flowEdges(nodes, [dto('a', { kind: 'agent', id: '1frontend1' }, { kind: 'agent', id: '1backend2' })], flags)[0]!
    const back = flowEdges(nodes, [dto('b', { kind: 'agent', id: '1backend2' }, { kind: 'agent', id: '1frontend1' })], flags)[0]!
    expect([there.sourceHandle, there.targetHandle, back.sourceHandle, back.targetHandle]).toEqual(['r', 'l', 'l', 'r'])
    expect(there.data!.label).toBe('N1frontend1 to N1backend2')
    // a two-way pair: the second one gets its own lane
    const pair = flowEdges(nodes, [dto('a', { kind: 'agent', id: '1frontend1' }, { kind: 'agent', id: '1backend2' }), dto('b', { kind: 'agent', id: '1backend2' }, { kind: 'agent', id: '1frontend1' })], flags)
    expect(pair.map((e) => e.data!.lane)).toEqual([0, 1])
    expect(there.data!.lane).toBe(0)
    // an edge to the Orchestrator agent is drawn on its node
    expect(flowEdges(nodes, [dto('o', { kind: 'agent', id: '1tester1' }, { kind: 'agent', id: 'o1' })], flags)[0]!.target).toBe('q1')
    expect(endpointOf(nodes, 'c')).toBeNull() // a console never connects
    expect(endpointOf(nodes, 'o1')).toEqual({ kind: 'squad', id: 'q1' })
    expect(endpointOf(nodes, 'q1')).toEqual({ kind: 'squad', id: 'q1' })
    expect(endpointOf(nodes, 'g1tester')).toEqual({ kind: 'group', id: 'g1tester' })
    expect(endpointOf(nodes, '1tester1')).toEqual({ kind: 'agent', id: '1tester1' })
    // the keyboard list: not itself, not a console, not the docked card (its node stands for it), not twice
    const list = destinations(nodes, { kind: 'agent', id: '1tester1' }, [dto('t', { kind: 'agent', id: '1tester1' }, { kind: 'group', id: 'g1backend' })])
    const keys = list.map((d) => `${d.target.kind}:${d.target.id}`)
    expect(keys).not.toContain('agent:1tester1')
    expect(keys).not.toContain('group:g1backend')
    expect(keys).toContain('group:g1tester')
    expect(keys.filter((k) => k === 'squad:q1')).toHaveLength(1)
    expect(list.find((d) => d.target.kind === 'squad')!.label).toBe('Orchestrator (No1)')
    expect(list).toHaveLength(7 + 3 + 1) // 7 other agents, 3 other groups, the Orchestrator
  })
})

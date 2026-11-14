import { describe, expect, it, vi } from 'vitest'
import { acceptLayout, buildSnapshot, planRestore, rebuildBoard, restoreNotice, sanitizeBoard, savedAgentProblem, type Layout } from '../../src/main/application/board'
import { FlowEngine } from '../../src/main/application/flow'
import { GroupRegistry } from '../../src/main/application/groups'
import { boardView, discardWorktrees, layoutOf, restoreBoard, type RestoreDeps } from '../../src/main/application/restore'
import { Slots } from '../../src/main/application/spawnMany'
import { SquadRegistry } from '../../src/main/application/squads'
import { AgentError, type Worktree } from '../../src/main/domain/agent'
import type { SavedAgent, SavedBoard } from '../../src/main/domain/board'
import type { Edge } from '../../src/main/domain/edge'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W1 = id(1), W2 = id(2)
const ORCH = id(10), F1 = id(11), F2 = id(12), CON = id(14), GF = id(20), SQ = id(30)
const repo = { root: '/r', name: 'r', branch: 'main' }
const wt = (role: string, n: number): Worktree => ({ repoRoot: '/r', path: `/wt/${role}-${n}`, branch: `agent/${role}-${n}`, base: 'b'.repeat(40) })
const saved = (aid: string, role: string, name: string, n: number, over: Partial<SavedAgent> = {}): SavedAgent => ({ id: aid, role, presetId: null, model: 'sonnet', name, systemPrompt: '', branch: `agent/${role}-${n}`, worktree: `/wt/${role}-${n}`, base: 'b'.repeat(40), sessionId: id(100 + n), pending: false, ...over })

function board(): SavedBoard {
  return {
    workspaces: [
      { id: W1, name: 'Workspace 1', order: 0, viewport: { x: 5, y: 6, zoom: 0.7 }, active: true },
      { id: W2, name: 'Workspace 2', order: 1, viewport: { x: 0, y: 0, zoom: 1 }, active: false },
    ],
    nodes: [
      { id: SQ, kind: 'orchestrator', workspaceId: W1, x: 900, y: 140, w: 300, h: 700, pinned: false, parentId: null, order: 0 },
      { id: ORCH, kind: 'agent', workspaceId: W1, x: 0, y: 0, w: 420, h: 280, pinned: false, parentId: SQ, order: 0 },
      { id: GF, kind: 'group', workspaceId: W1, x: 24, y: 140, w: 876, h: 304, pinned: false, parentId: null, order: 0 },
      { id: F2, kind: 'agent', workspaceId: W1, x: 444, y: 12, w: 420, h: 280, pinned: false, parentId: GF, order: 1 },
      { id: F1, kind: 'agent', workspaceId: W1, x: 12, y: 12, w: 420, h: 280, pinned: false, parentId: GF, order: 0 },
      { id: CON, kind: 'console', workspaceId: W2, x: 300, y: 400, w: 420, h: 280, pinned: true, parentId: null, order: 0 },
    ],
    agents: [saved(ORCH, 'orchestrator', 'Max', 1, { model: null }), saved(F1, 'frontend', 'Zoe', 1), saved(F2, 'frontend', 'Leo', 2)],
    groups: [{ id: GF, name: 'Frontend', collapsed: false, presetId: null }],
    squads: [{ id: SQ, orchestratorId: ORCH, groupIds: [GF], extraIds: [F2] }],
    edges: [
      { id: id(40), workspaceId: W1, source: { kind: 'group', id: GF }, target: { kind: 'squad', id: SQ }, template: 'From {name}:\n{message}', condition: '', paused: null },
      { id: id(41), workspaceId: W1, source: { kind: 'agent', id: F1 }, target: { kind: 'agent', id: F2 }, template: 'Review {message}', condition: 'DONE', paused: 'Paused by you' },
    ],
  }
}

describe('savedAgentProblem: nothing read back from the database is trusted', () => {
  it('accepts a sane agent and refuses malformed fields', () => {
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1))).toBeNull()
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { sessionId: 'nope' }))).toBe('its saved session is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { sessionId: `${id(1)} --dangerously-skip-permissions` }))).toBe('its saved session is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { sessionId: '--resume=x' }))).toBe('its saved session is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', '../x', 1))).toBe('its saved data is not valid')
    expect(savedAgentProblem(saved(F1, 'Front End', 'Zoe', 1))).toBe('its saved data is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { model: '--evil' }))).toBe('its saved model is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { branch: 'main' }))).toBe('its saved branch is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { branch: 'agent/backend-1' }))).toBe('its saved branch is not valid')
    expect(savedAgentProblem(saved(F1, 'frontend', 'Zoe', 1, { base: 'HEAD; rm -rf /' }))).toBe('its saved branch is not valid')
  })
})

describe('planRestore', () => {
  it('relaunches the valid agents whose worktree checked out, then the consoles, within the free terminals', () => {
    const p = planRestore(board(), new Map([[F2, 'its worktree is missing']]), 20)
    expect(p.agents.map((a) => a.name)).toEqual(['Max', 'Zoe'])
    expect(p.consoles.map((c) => c.id)).toEqual([CON])
    expect(p.skipped).toEqual([{ name: 'Leo', branch: 'agent/frontend-2', id: F2, keep: true, reason: 'its worktree is missing' }])
  })
  it('skips what does not fit and what is malformed, saying why; agents not on the board are ignored', () => {
    const b = board()
    b.agents.push(saved(id(99), 'qa', 'Ada', 1)) // no node: not on the board
    b.agents[1] = { ...b.agents[1]!, sessionId: 'x' }
    const p = planRestore(b, new Map(), 2)
    expect(p.agents.map((a) => a.name)).toEqual(['Max', 'Leo'])
    expect(p.consoles).toEqual([])
    expect(p.skipped).toEqual([
      { name: 'Zoe', reason: 'its saved session is not valid' },
      { name: 'a console', reason: 'no terminal was free' },
    ])
    expect(planRestore(b, new Map(), 0).agents).toEqual([])
  })
})

describe('rebuildBoard', () => {
  it('remaps the terminals that came back and drops what lost its ends', () => {
    // Zoe (F1) did not come back: her edge goes, the group keeps Leo, the squad stays
    const ids = new Map([[ORCH, id(50)], [F2, id(52)], [CON, id(54)]])
    const r = rebuildBoard(board(), ids)
    expect(r.nodes.find((n) => n.id === id(52))).toMatchObject({ parentId: GF, x: 444 })
    expect(r.nodes.find((n) => n.id === id(54))).toMatchObject({ workspaceId: W2, x: 300, y: 400, pinned: true })
    expect(r.nodes.some((n) => n.id === F1 || n.id === F2)).toBe(false)
    expect(r.groups.map((g) => g.id)).toEqual([GF])
    expect(r.squads).toEqual([{ id: SQ, orchestratorId: id(50), groupIds: [GF], extraIds: [id(52)] }])
    expect(r.edges.map((e) => e.id)).toEqual([id(40)])
    expect(r.agents.map((a) => a.id)).toEqual([id(50), id(52)])
  })
  it('a group with no member left goes, and so does every edge on it; a squad goes with its Orchestrator', () => {
    const r = rebuildBoard(board(), new Map([[CON, id(54)]]))
    expect(r.groups).toEqual([])
    expect(r.squads).toEqual([])
    expect(r.edges).toEqual([])
    expect(r.nodes.map((n) => n.id)).toEqual([id(54)])
  })
})

describe('buildSnapshot and acceptLayout', () => {
  const layout: Layout = {
    workspaces: [{ id: W1, name: 'Workspace 1', viewport: { x: 1, y: 2, zoom: 1 } }, { id: W2, name: 'Workspace 2', viewport: { x: 0, y: 0, zoom: 1 } }],
    active: W2,
    nodes: [
      { id: GF, workspaceId: W1, x: 24, y: 140, w: 876, h: 304, pinned: false, collapsed: true },
      { id: CON, workspaceId: W2, x: 7, y: 8, w: 420, h: 280, pinned: true, collapsed: false },
      { id: SQ, workspaceId: W1, x: 900, y: 140, w: 300, h: 700, pinned: false, collapsed: false },
    ],
  }
  it('board:saveLayout keeps only ids this window owns, in workspaces it names', () => {
    const mine = new Set([GF, CON])
    const l = acceptLayout({ ...layout, nodes: [...layout.nodes, { ...layout.nodes[1]!, id: id(77) }, { ...layout.nodes[1]!, id: id(78), workspaceId: id(3) }] }, (x) => mine.has(x))
    expect(l.nodes.map((n) => n.id)).toEqual([GF, CON])
    expect(acceptLayout({ ...layout, active: id(3) }, () => true).active).toBe(W1)
  })
  it('saves what main knows with the layout, consistently (no path ever leaves main in it except the worktree it owns)', () => {
    const edge = (eid: string, source: Edge['source'], target: Edge['target']): Edge => ({ id: eid, ownerId: 1, workspaceId: W1, source, target, template: 't {message}', condition: '', paused: null, note: 'x' })
    const s = buildSnapshot(
      {
        agents: [
          { id: ORCH, workspaceId: W1, role: 'orchestrator', name: 'Max', worktree: wt('orchestrator', 1), sessionId: id(101) },
          { id: F1, workspaceId: W1, role: 'frontend', presetId: id(90), model: 'sonnet', systemPrompt: 'sp', name: 'Zoe', worktree: wt('frontend', 1), sessionId: id(102) },
        ],
        consoles: [CON],
        groups: [{ id: GF, name: 'Frontend', memberIds: [F1] }],
        squads: [{ id: SQ, orchestratorId: ORCH, groupIds: [GF, id(66)], extraIds: [id(67)] }],
        edges: [edge(id(40), { kind: 'group', id: GF }, { kind: 'squad', id: SQ }), edge(id(42), { kind: 'agent', id: id(68) }, { kind: 'squad', id: SQ })],
        layout,
      },
      () => id(999),
    )
    expect(s.workspaces.map((w) => [w.id, w.active, w.order])).toEqual([[W1, false, 0], [W2, true, 1]])
    expect(s.agents[1]).toEqual({ id: F1, role: 'frontend', presetId: id(90), model: 'sonnet', name: 'Zoe', systemPrompt: 'sp', branch: 'agent/frontend-1', worktree: '/wt/frontend-1', base: 'b'.repeat(40), sessionId: id(102), pending: false })
    expect(s.nodes.find((n) => n.id === ORCH)).toMatchObject({ kind: 'agent', parentId: SQ })
    expect(s.nodes.find((n) => n.id === F1)).toMatchObject({ parentId: GF, order: 0, workspaceId: W1 })
    expect(s.nodes.find((n) => n.id === CON)).toMatchObject({ kind: 'console', workspaceId: W2, x: 7, y: 8, pinned: true })
    expect(s.groups).toEqual([{ id: GF, name: 'Frontend', collapsed: true, presetId: null }])
    expect(s.squads).toEqual([{ id: SQ, orchestratorId: ORCH, groupIds: [GF], extraIds: [] }])
    expect(s.edges.map((e) => e.id)).toEqual([id(40)]) // the one whose source is gone is not saved
    expect(Object.keys(s.edges[0]!)).not.toContain('note')
  })
  it('without a layout yet, workspaces come from what main knows', () => {
    const s = buildSnapshot({ agents: [], consoles: [CON], groups: [], squads: [], edges: [], layout: null }, () => id(999))
    expect(s.workspaces).toEqual([{ id: id(999), name: 'Workspace 1', order: 0, viewport: { x: 0, y: 0, zoom: 1 }, active: true }])
    expect(s.nodes[0]).toMatchObject({ id: CON, workspaceId: id(999) })
    expect(buildSnapshot({ agents: [], consoles: [], groups: [], squads: [], edges: [], layout: null }, () => id(999)).workspaces).toEqual([])
  })
})

describe('restoreNotice', () => {
  it('one line, or nothing', () => {
    expect(restoreNotice([])).toBeNull()
    expect(restoreNotice([{ name: 'Zoe', reason: 'its worktree is missing' }])).toBe('1 terminal did not come back: Zoe (its worktree is missing).')
    expect(restoreNotice(Array.from({ length: 50 }, () => ({ name: 'Zoe', reason: 'its worktree is missing' })))!.length).toBeLessThanOrEqual(400)
  })
})

describe('restoreBoard', () => {
  function deps(o: { failSpawn?: string; missing?: string; cancelAfter?: number; noTranscript?: string } = {}) {
    let n = 0
    const owned = new Set<string>()
    const agentsById = new Map<string, { id: string; name: string; role: string; workspaceId?: string }>()
    const groups = new GroupRegistry(() => true, () => `g${++n}`)
    const squads = new SquadRegistry(() => `s${++n}`)
    const flow = new FlowEngine(
      {
        agent: (_o, aid) => agentsById.get(aid),
        group: (oo, gid) => groups.get(oo, gid),
        groupOf: (aid) => groups.groupOf(aid),
        squad: (oo, sid) => squads.get(oo, sid),
        lastMessage: async () => null,
        readiness: () => 'idle',
        deliver: async () => undefined,
        now: () => 0,
        emit: () => undefined,
      },
      () => `e${++n}`,
    )
    const restore = vi.fn(async (_o: number, req: Parameters<RestoreDeps['agents']['restore']>[1]) => {
      if (req.name === o.failSpawn) throw new AgentError('boom')
      const aid = id(500 + ++n)
      owned.add(aid)
      agentsById.set(aid, { id: aid, name: req.name, role: req.role, workspaceId: req.workspaceId })
      return { id: aid, name: req.name, role: req.role, branch: req.worktree.branch, model: req.model ?? 'default', state: 'starting' as const, statusUnavailable: false }
    })
    const adopt = vi.fn(async (_r: unknown, s: { path: string; branch: string; role: string; base: string }) => {
      if (s.path === o.missing) throw new AgentError('its worktree is missing')
      return { repoRoot: '/r', path: s.path, branch: s.branch, base: s.base }
    })
    const remove = vi.fn(async () => 'removed' as const)
    const stop = vi.fn(async () => undefined)
    const d: RestoreDeps = {
      worktrees: { adopt, remove },
      agents: { restore },
      consoles: { spawn: () => ({ id: id(600 + ++n), name: 'console-1' }) },
      groups,
      squads,
      flow,
      slots: new Slots(() => 0, 20),
      canResume: (cwd) => cwd !== o.noTranscript,
      cancelled: () => o.cancelAfter !== undefined && restore.mock.calls.length >= o.cancelAfter,
      stop,
    }
    return { d, restore, adopt, remove, stop, groups, squads, flow }
  }

  it('resume: each agent in its worktree with its session, under its name and in its workspace; groups, squads and edges come back with their ids', async () => {
    const { d, restore, groups, squads, flow } = deps()
    const r = await restoreBoard(d, 1, repo, board(), true)
    expect(restore.mock.calls.map((c) => [c[1].name, c[1].sessionId, c[1].resume, c[1].worktree.path, c[1].workspaceId])).toEqual([
      ['Max', id(101), true, '/wt/orchestrator-1', W1],
      ['Zoe', id(101), true, '/wt/frontend-1', W1],
      ['Leo', id(102), true, '/wt/frontend-2', W1],
    ])
    expect(r.skipped).toEqual([])
    expect(groups.get(1, GF)!.memberIds).toEqual([...r.agents.values()].filter((a) => a.role === 'frontend').map((a) => a.id)) // in their saved order
    expect(squads.get(1, SQ)).toMatchObject({ groupIds: [GF] })
    expect(flow.list(1).map((e) => [e.id, e.condition, e.paused])).toEqual([[id(40), '', null], [id(41), 'DONE', 'Paused by you']])
    const v = boardView(r, flow.list(1))
    expect(v.active).toBe(W1)
    expect(v.terminals).toHaveLength(4)
    expect(v.squads[0]).toMatchObject({ id: SQ, x: 900, y: 140, groups: [{ id: GF, role: 'frontend' }] })
    expect(v.groups[0]).toMatchObject({ id: GF, name: 'Frontend', memberIds: v.groups[0]!.memberIds })
    expect(JSON.stringify(v)).not.toContain('/wt/') // no path for the renderer
    expect(layoutOf(r.board).nodes.find((n) => n.id === GF)).toMatchObject({ collapsed: false, x: 24 })
  })

  it('fresh: no resume; a missing worktree or a failed spawn only skips that agent', async () => {
    const { d, restore, flow } = deps({ missing: '/wt/frontend-1', failSpawn: 'Leo' })
    const r = await restoreBoard(d, 1, repo, board(), false)
    expect(restore.mock.calls.every((c) => c[1].resume === false)).toBe(true)
    expect(r.skipped).toEqual([
      { name: 'Zoe', branch: 'agent/frontend-1', id: F1, keep: true, reason: 'its worktree is missing' },
      { name: 'Leo', branch: 'agent/frontend-2', id: F2, keep: true, reason: 'it could not start' },
    ])
    // both stay on the saved board, to be tried again at the next start
    expect(r.pending.agents.map((a) => a.name)).toEqual(['Zoe', 'Leo'])
    expect(r.pending.nodes.map((x) => x.id).sort()).toEqual([F1, F2].sort())
    expect(r.board.groups).toEqual([]) // nobody of the group is back
    expect(r.board.squads).toEqual([{ id: SQ, orchestratorId: [...r.agents.keys()][0], groupIds: [], extraIds: [] }])
    expect(flow.list(1)).toEqual([])
    expect(r.consoles.size).toBe(1)
  })

  it('takes slots only for what it relaunches and gives them all back', async () => {
    const { d } = deps()
    const used = { n: 18 }
    d.slots = new Slots(() => used.n, 20)
    const r = await restoreBoard(d, 1, repo, board(), true)
    expect(r.agents.size).toBe(2)
    expect(r.skipped.map((s) => s.reason)).toEqual(['no terminal was free', 'no terminal was free'])
    expect(d.slots.pending).toBe(false)
  })

  it('resumes only a session whose transcript exists; the others start fresh', async () => {
    const { d, restore } = deps({ noTranscript: '/wt/frontend-1' })
    await restoreBoard(d, 1, repo, board(), true)
    expect(restore.mock.calls.map((c) => [c[1].name, c[1].resume])).toEqual([['Max', true], ['Zoe', false], ['Leo', true]])
  })

  it('cancelled (window gone, app leaving): stops what already started, starts nothing more, builds nothing', async () => {
    const { d, restore, stop, groups, squads, flow } = deps({ cancelAfter: 1 })
    const r = await restoreBoard(d, 1, repo, board(), true)
    expect(r.cancelled).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
    const started = (await restore.mock.results[0]!.value) as { id: string }
    expect(stop).toHaveBeenCalledWith(1, [started.id])
    expect(groups.get(1, GF)).toBeUndefined()
    expect(squads.get(1, SQ)).toBeUndefined()
    expect(flow.list(1)).toEqual([])
    expect(r.board.nodes).toEqual([])
  })

  it('agents beyond the free terminals stay pending with their branch; a pending one says it is again', async () => {
    const { d } = deps()
    d.slots = new Slots(() => 19, 20)
    const b = board()
    b.agents[2] = { ...b.agents[2]!, pending: true }
    const r = await restoreBoard(d, 1, repo, b, true)
    expect(r.skipped.map((x) => [x.name, x.branch, x.reason])).toEqual([['Zoe', 'agent/frontend-1', 'no terminal was free'], ['Leo', 'agent/frontend-2', 'no terminal was free, again'], ['a console', undefined, 'no terminal was free']])
    expect(r.pending.agents.map((a) => a.name)).toEqual(['Zoe', 'Leo'])
    expect(restoreNotice(r.skipped)).toContain('Zoe (agent/frontend-1, no terminal was free)')
    // saved again with the live board: pending, with their nodes, and never as a card of a group that is gone
    const s = buildSnapshot({ agents: [], consoles: [], groups: [], squads: [], edges: [], layout: layoutOf(r.board), pending: r.pending }, () => id(999))
    expect(s.agents.map((a) => [a.name, a.pending])).toEqual([['Zoe', true], ['Leo', true]])
    expect(s.nodes.filter((x) => x.kind === 'agent').map((x) => x.parentId)).toEqual([null, null])
  })

  it('Empty board applies the removal policy to every worktree that checks out, with the confirmation; one that does not is never touched, only listed', async () => {
    const { d, remove } = deps({ missing: '/wt/frontend-2' })
    const confirm = vi.fn(async () => 'keep' as const)
    expect(await discardWorktrees(d, repo, board(), confirm)).toEqual({ kept: 0, archived: 0, left: [{ name: 'Leo', branch: 'agent/frontend-2', reason: 'its worktree is missing' }] })
    expect(remove.mock.calls.map((c) => [(c as unknown as [Worktree])[0].path, (c as unknown as [Worktree, unknown])[1]])).toEqual([['/wt/orchestrator-1', confirm], ['/wt/frontend-1', confirm]])
  })
})

describe('board:saveLayout schema (the renderer is not trusted either)', () => {
  it('bounds every field', async () => {
    const { channels } = await import('../../src/shared/ipc/channels')
    const ws = { id: W1, name: 'Workspace 1', viewport: { x: 0, y: 0, zoom: 1 } }
    const node = { id: CON, workspaceId: W1, x: 1, y: 2, w: 420, h: 280, pinned: false, collapsed: false }
    const ok = (v: unknown) => channels['board:saveLayout'].in.safeParse(v).success
    expect(ok({ workspaces: [ws], active: W1, nodes: [node] })).toBe(true)
    expect(ok({ workspaces: [], active: W1, nodes: [] })).toBe(false)
    expect(ok({ workspaces: Array.from({ length: 9 }, () => ws), active: W1, nodes: [] })).toBe(false)
    expect(ok({ workspaces: [{ ...ws, name: 'a\u0007' }], active: W1, nodes: [] })).toBe(false)
    expect(ok({ workspaces: [{ ...ws, viewport: { x: 0, y: 0, zoom: 99 } }], active: W1, nodes: [] })).toBe(false)
    expect(ok({ workspaces: [ws], active: W1, nodes: [{ ...node, x: Number.NaN }] })).toBe(false)
    expect(ok({ workspaces: [ws], active: W1, nodes: [{ ...node, x: 1e9 }] })).toBe(false)
    expect(ok({ workspaces: [ws], active: W1, nodes: [{ ...node, id: '../../etc/passwd' }] })).toBe(false)
    expect(ok({ workspaces: [ws], active: W1, nodes: Array.from({ length: 401 }, () => node) })).toBe(false)
    expect(ok({ workspaces: [ws], active: W1, nodes: [{ ...node, path: '/tmp' }] })).toBe(true) // unknown keys are stripped, never used
    expect((channels['board:saveLayout'].in.parse({ workspaces: [ws], active: W1, nodes: [{ ...node, path: '/tmp' }] }).nodes[0] as Record<string, unknown>)['path']).toBeUndefined()
  })
})

describe('sanitizeBoard: a tampered database never reaches a spawn or the renderer', () => {
  it('drops each invalid item and keeps the rest', () => {
    const b = board()
    b.workspaces.push(...Array.from({ length: 9 }, (_, i) => ({ id: id(700 + i), name: `Workspace ${i + 3}`, order: 2 + i, viewport: { x: 0, y: 0, zoom: 1 }, active: false })))
    b.workspaces.push({ id: 'not-a-uuid', name: 'x', order: 0, viewport: { x: 0, y: 0, zoom: 1 }, active: false })
    b.agents[2] = { ...b.agents[2]!, systemPrompt: 'x'.repeat(20_001) } // Leo: dropped, never relaunched
    b.agents.push(saved('../x', 'qa', 'Ada', 1))
    b.groups.push({ id: id(80), name: 'bad\u0007', collapsed: false, presetId: null })
    b.edges.push({ ...b.edges[0]!, id: id(42), paused: 'p'.repeat(201) }, { ...b.edges[0]!, id: id(43), template: '  ' }, { ...b.edges[0]!, id: id(44), source: { kind: 'group', id: "'; DROP" } })
    b.nodes.push({ ...b.nodes[5]!, id: id(81), x: Number.NaN, y: 1e12 })
    const { board: s, dropped } = sanitizeBoard(b)
    expect(s.workspaces).toHaveLength(8)
    expect(s.agents.map((a) => a.name)).toEqual(['Max', 'Zoe'])
    expect(s.nodes.some((n) => n.id === F2)).toBe(false)
    expect(s.groups.map((g) => g.id)).toEqual([GF])
    expect(s.edges.map((e) => e.id)).toEqual([id(40), id(41)])
    expect(s.nodes.find((n) => n.id === id(81))).toMatchObject({ x: 0, y: 1_000_000 })
    expect(dropped).toBeGreaterThanOrEqual(7)
    expect(planRestore(s, new Map(), 20).agents.map((a) => a.name)).toEqual(['Max', 'Zoe'])
  })
})

describe('keepOnBoard (renderer): cards the window already had stay when a saved board comes back', () => {
  it('moves them together onto the restored active board, at its next free spot, keeping a group with its members', async () => {
    const { boardNodes, cardNode, joinGroup, keepOnBoard } = await import('../../src/renderer/graph')
    const restored = boardNodes({ workspaces: [{ id: W1, name: 'Workspace 1', viewport: { x: 0, y: 0, zoom: 1 } }], active: W1, terminals: [{ id: F1, workspaceId: W1, x: 24, y: 140, w: 420, h: 280, pinned: false, name: 'Zoe', agent: { id: F1, name: 'Zoe', role: 'frontend', branch: 'agent/frontend-1', model: 'sonnet', state: 'starting', statusUnavailable: false } }], groups: [], squads: [], edges: [] }, 1)
    const old = 'old-ws'
    const cards = [cardNode(id(91), { ptyId: id(91), name: 'console-1', status: 'running', startedAt: 1, workspaceId: old }, { x: 500, y: 600 }), cardNode(id(92), { ptyId: id(92), name: 'console-2', status: 'running', startedAt: 1, workspaceId: old }, { x: 1000, y: 600 })]
    const kept = joinGroup(cards, { id: id(93), name: 'Scratch' }, [id(91)])
    const out = keepOnBoard(restored, kept, W1)
    expect(out.map((n) => n.id).sort()).toEqual([F1, id(91), id(92), id(93)].sort())
    expect(out.findIndex((n) => n.id === id(93))).toBeLessThan(out.findIndex((n) => n.id === id(91))) // parent before child
    expect(out.every((n) => n.data.workspaceId === W1)).toBe(true)
    const group = out.find((n) => n.id === id(93))!
    const loose = out.find((n) => n.id === id(92))!
    expect(group.position.x).toBeGreaterThan(24 + 420) // right of the restored card, never on top of it
    expect(loose.position.x - group.position.x).toBe(1000 - (500 - 12)) // moved together
    expect(out.find((n) => n.id === id(91))!.parentId).toBe(id(93))
    expect(keepOnBoard(restored, [], W1)).toBe(restored)
  })
})

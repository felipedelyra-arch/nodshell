import { describe, expect, it, vi } from 'vitest'
import type { SpawnedAgent, SpawnRequest } from '../../src/main/application/agents'
import { GroupRegistry } from '../../src/main/application/groups'
import { DENY_COOLDOWN_MS, DENY_STREAK_MAX, SquadSpawner, type SpawnAgentDeps, type SpawnJoined, type SpawnQuestion } from '../../src/main/application/spawnAgent'
import { Slots } from '../../src/main/application/spawnMany'
import { SquadRegistry } from '../../src/main/application/squads'
import { TaskBoard } from '../../src/main/application/tasks'
import { AgentError, type Repo } from '../../src/main/domain/agent'
import { BUILTIN_PRESETS, type Preset } from '../../src/main/domain/preset'
import { SQUAD_EXTRAS_MAX } from '../../src/main/domain/squad'
import { MAX_LIVE } from '../../src/shared/agent'

const repo: Repo = { root: '/r', name: 'r', branch: 'main' }
const presets: Preset[] = [
  ...BUILTIN_PRESETS.map((p, i): Preset => ({ ...p, model: null, id: `p${i}`, adapter: 'claude', builtin: true, createdAt: 1 })),
  { name: 'Docs', role: 'docs', model: 'haiku', systemPrompt: 'write docs', id: 'pd', adapter: 'claude', builtin: false, createdAt: 2 },
]
const me = { id: 'orch', ownerId: 1, name: 'Max', role: 'orchestrator', workspaceId: 'w1' }

/** A squad led by `orch` with Frontend (f1, f2) and Backend (b1, b2) groups; `used` live processes besides. */
function world(opts: { used?: number; answer?: boolean | (() => Promise<boolean>) } = {}) {
  const roles = new Map<string, string>([['orch', 'orchestrator'], ['f1', 'frontend'], ['f2', 'frontend'], ['b1', 'backend'], ['b2', 'backend']])
  let n = 0
  const groups = new GroupRegistry(() => true, () => `g${++n}`)
  const squads = new SquadRegistry(() => 'q1')
  const gf = groups.create(1, 'Frontend', ['f1', 'f2'])
  const gb = groups.create(1, 'Backend', ['b1', 'b2'])
  const squad = squads.create(1, 'orch', [gf.id, gb.id])
  let live = opts.used ?? 5
  const slots = new Slots(() => live, MAX_LIVE)
  let k = 0
  const spawn = vi.fn(async (_o: number, _r: Repo | null, req: SpawnRequest): Promise<SpawnedAgent> => {
    await Promise.resolve()
    const id = `x${++k}`
    roles.set(id, req.role)
    live++
    return { id, name: `Uma${k}`, role: req.role, branch: `agent/${req.role}-3`, model: req.model ?? 'default', state: 'starting', statusUnavailable: false }
  })
  const joined: SpawnJoined[] = []
  const questions: SpawnQuestion[] = []
  const tasks = new TaskBoard(() => undefined, (() => { let t = 0; return () => `t${++t}` })())
  // hold queues the task for the agent, as the FlowEngine does
  const hold = vi.fn((_o: number, _from: string, to: { id: string }, _text: string, tag?: string) => void (tag && tasks.track(to.id, [tag], 'queued')))
  const flow = { create: vi.fn((ownerId: number, source: { kind: 'agent' | 'group'; id: string }, target: { kind: 'agent' | 'group' | 'squad'; id: string }) => ({ id: 'e1', ownerId, workspaceId: 'w1', source, target, template: 't', condition: '', paused: null, note: null })), hold, charge: vi.fn() }
  const state = { paused: false }
  const answer = opts.answer ?? true
  const d: SpawnAgentDeps = {
    presets: { list: () => presets },
    agents: { spawn, get: (_o, id) => (roles.has(id) ? { role: roles.get(id)! } : undefined) },
    groups,
    squads,
    slots,
    flow,
    tasks,
    repo: () => repo,
    paused: () => state.paused,
    confirm: vi.fn(async (_o: number, q: SpawnQuestion) => (questions.push(q), typeof answer === 'function' ? answer() : answer)),
    joined: (_o, j) => void joined.push(j),
  }
  return { s: new SquadSpawner(d), d, spawn, groups, squads, squad, gf, gb, slots, flow, tasks, joined, questions, state }
}

describe('spawn_agent (SquadSpawner)', () => {
  it('asks the user, then starts the agent in its role\'s group of the squad; its task is held for its first idle, as a squad task', async () => {
    const w = world()
    const text = await w.s.spawn(me, { preset: 'backend', task: 'Write the API\nwith tests\u001b[31m', model: 'sonnet' })
    expect(text).toBe('Started Uma1 (Backend) in group Backend. Your task goes to Uma1 as its first prompt once it is ready')
    expect(w.questions).toEqual([{ orchestrator: 'Max', preset: 'Backend', model: 'sonnet', task: 'Write the API\nwith tests[31m' }])
    expect(w.spawn).toHaveBeenCalledTimes(1)
    const req = w.spawn.mock.calls[0]![2]
    expect(req).toEqual({ role: 'backend', model: 'sonnet', systemPrompt: BUILTIN_PRESETS[1]!.systemPrompt, cols: 80, rows: 24, workspaceId: 'w1', presetId: presets[1]!.id }) // never a path, command or bypass
    expect(w.gb.memberIds).toEqual(['b1', 'b2', 'x1'])
    expect(w.squad).toMatchObject({ groupIds: [w.gf.id, w.gb.id], extraIds: ['x1'] })
    expect(w.joined).toEqual([{ squadId: 'q1', group: { id: w.gb.id, name: 'Backend', role: 'backend', created: false }, agent: expect.objectContaining({ id: 'x1', name: 'Uma1', state: 'starting' }), workspaceId: 'w1' }])
    expect(w.flow.create).not.toHaveBeenCalled() // its group is already linked
    expect(w.flow.charge).toHaveBeenCalledTimes(1)
    expect(w.flow.hold).toHaveBeenCalledWith(1, 'orch', { id: 'x1', name: 'Uma1', role: 'backend', workspaceId: 'w1' }, 'From Max (orchestrator):\nWrite the API\nwith tests\u001b[31m', 't1')
    expect(w.tasks.list('q1')).toMatchObject([{ title: 'Write the API', assignee: { kind: 'agent', id: 'x1', name: 'Uma1' }, status: 'queued' }])
    expect(w.slots.free()).toBe(MAX_LIVE - 6)
  })

  it('a role the squad has no group for gets a new group, linked to the Orchestrator; the preset model is the default', async () => {
    const w = world()
    await w.s.spawn(me, { preset: 'Docs', task: 'document it' })
    expect(w.spawn.mock.calls[0]![2]).toMatchObject({ role: 'docs', model: 'haiku' })
    expect(w.questions[0]!.model).toBe('haiku')
    const g = w.groups.groupOf('x1')!
    expect(g.name).toBe('Docs')
    expect(w.squad.groupIds).toEqual([w.gf.id, w.gb.id, g.id])
    expect(w.joined[0]!.group).toEqual({ id: g.id, name: 'Docs', role: 'docs', created: true })
    expect(w.flow.create).toHaveBeenCalledWith(1, { kind: 'group', id: g.id }, { kind: 'squad', id: 'q1' })
  })

  it('denied (or the dialog closed): nothing is created and the agent is told', async () => {
    const w = world({ answer: false })
    await expect(w.s.spawn(me, { preset: 'Backend', task: 'x' })).rejects.toThrow('The user denied the request, nothing was started')
    expect(w.spawn).not.toHaveBeenCalled()
    expect(w.gb.memberIds).toHaveLength(2)
    expect(w.squad.extraIds).toEqual([])
    expect(w.tasks.list('q1')).toEqual([])
    expect(w.slots.free()).toBe(MAX_LIVE - 5)
  })

  it.each([
    ['a caller that leads no squad', { ...me, id: 'sol', name: 'Sol' }, { preset: 'Backend', task: 'x' }, 'Only an Orchestrator leading a squad can spawn agents'],
    ['an unknown preset', me, { preset: 'Nope', task: 'x' }, 'No preset named Nope'],
    ['another Orchestrator', me, { preset: 'orchestrator', task: 'x' }, 'An Orchestrator cannot spawn another Orchestrator'],
  ])('refuses %s before asking', async (_n, caller, input, msg) => {
    const w = world()
    await expect(w.s.spawn(caller, input)).rejects.toThrow(msg)
    expect(w.d.confirm).not.toHaveBeenCalled()
    expect(w.spawn).not.toHaveBeenCalled()
  })

  it('refuses at the live-process limit, counting the slots other batches reserved', async () => {
    const full = world({ used: MAX_LIVE })
    await expect(full.s.spawn(me, { preset: 'Backend', task: 'x' })).rejects.toThrow(`Only 0 of ${MAX_LIVE} terminals are free, cannot start 1`)
    expect(full.d.confirm).not.toHaveBeenCalled()
    const w = world({ used: MAX_LIVE - 2 })
    const batch = w.slots.reserve(2) // e.g. a Spawn N under way
    await expect(w.s.spawn(me, { preset: 'Backend', task: 'x' })).rejects.toThrow('Only 0 of')
    batch.release()
    await w.s.spawn(me, { preset: 'Backend', task: 'x' })
    expect(w.spawn).toHaveBeenCalledTimes(1)
  })

  it(`at most ${SQUAD_EXTRAS_MAX} extras per squad; a closed extra frees its place`, async () => {
    const w = world()
    for (let i = 0; i < SQUAD_EXTRAS_MAX; i++) await w.s.spawn(me, { preset: 'Frontend', task: `t${i}` })
    expect(w.gf.memberIds).toHaveLength(2 + SQUAD_EXTRAS_MAX)
    await expect(w.s.spawn(me, { preset: 'Frontend', task: 'one more' })).rejects.toThrow(`Your squad already has ${SQUAD_EXTRAS_MAX} extra agents`)
    w.squads.forget('x3')
    await w.s.spawn(me, { preset: 'Frontend', task: 'now it fits' })
    expect(w.spawn).toHaveBeenCalledTimes(SQUAD_EXTRAS_MAX + 1)
  })

  it('after a Deny the Orchestrator waits 60 s; after 3 in a row it is off until the user prompts it; an approval resets the count', async () => {
    const answers: boolean[] = []
    const w = world({ answer: async () => answers.shift() ?? false })
    let t = 0
    w.d.now = () => t
    const ask = () => w.s.spawn(me, { preset: 'Backend', task: 'x' })
    answers.push(false)
    await expect(ask()).rejects.toThrow('The user denied the request, nothing was started')
    await expect(ask()).rejects.toThrow('The user denied your last request; wait 60 s before asking again')
    t += DENY_COOLDOWN_MS - 1500
    await expect(ask()).rejects.toThrow('wait 2 s')
    expect(w.d.confirm).toHaveBeenCalledTimes(1) // no dialog while waiting
    for (let i = 1; i < DENY_STREAK_MAX; i++) {
      t += DENY_COOLDOWN_MS
      await expect(ask()).rejects.toThrow('The user denied the request')
    }
    t += 10 * DENY_COOLDOWN_MS
    await expect(ask()).rejects.toThrow(`The user denied ${DENY_STREAK_MAX} requests in a row; spawn_agent is off until the user prompts you again`)
    expect(w.d.confirm).toHaveBeenCalledTimes(DENY_STREAK_MAX)
    w.s.userPrompted('someone else')
    await expect(ask()).rejects.toThrow('in a row')
    w.s.userPrompted('orch')
    answers.push(true)
    await ask()
    // the approval cleared the streak: two more Denies do not lock it yet
    for (let i = 0; i < DENY_STREAK_MAX - 1; i++) {
      t += DENY_COOLDOWN_MS
      answers.push(false)
      await expect(ask()).rejects.toThrow('The user denied the request')
    }
    t += DENY_COOLDOWN_MS
    answers.push(true)
    await ask()
    expect(w.spawn).toHaveBeenCalledTimes(2)
  })

  it('one request at a time per Orchestrator: a second one while the dialog is open is refused', async () => {
    let answer: (v: boolean) => void = () => undefined
    let asked = 0
    const w = world({ answer: () => (asked++ === 0 ? new Promise<boolean>((r) => (answer = r)) : Promise.resolve(true)) })
    const first = w.s.spawn(me, { preset: 'Backend', task: 'a' })
    await expect(w.s.spawn(me, { preset: 'Backend', task: 'b' })).rejects.toThrow('Another spawn request of yours is still waiting')
    answer(true)
    await first
    await w.s.spawn(me, { preset: 'Backend', task: 'c' }) // free again
    expect(w.spawn).toHaveBeenCalledTimes(2)
  })

  it('refused while paused, also when Pause all came while the dialog was open; the burst guard counts the request', async () => {
    const w = world()
    w.state.paused = true
    await expect(w.s.spawn(me, { preset: 'Backend', task: 'x' })).rejects.toThrow('Everything is paused')
    expect(w.d.confirm).not.toHaveBeenCalled()
    const late = world({ answer: async () => ((late.state.paused = true), true) })
    await expect(late.s.spawn(me, { preset: 'Backend', task: 'x' })).rejects.toThrow('Everything is paused')
    expect(late.spawn).not.toHaveBeenCalled()
    const burst = world()
    burst.flow.charge.mockImplementation(() => {
      throw new AgentError('Too many messages, all flows paused')
    })
    await expect(burst.s.spawn(me, { preset: 'Backend', task: 'x' })).rejects.toThrow('Too many messages')
    expect(burst.d.confirm).not.toHaveBeenCalled()
  })

  it('the squad gone during the spawn: the agent still gets a card, without a group or a task', async () => {
    const w = world()
    w.spawn.mockImplementationOnce(async (_o, _r, req) => {
      w.squads.forget('orch')
      return { id: 'x9', name: 'Uma9', role: req.role, branch: 'agent/backend-3', model: 'default', state: 'starting', statusUnavailable: false }
    })
    expect(await w.s.spawn(me, { preset: 'Backend', task: 'x' })).toBe('Started Uma9, but your squad is gone, so the task was not given')
    expect(w.joined).toEqual([{ squadId: null, group: null, agent: expect.objectContaining({ id: 'x9' }), workspaceId: 'w1' }])
    expect(w.flow.hold).not.toHaveBeenCalled()
  })
})

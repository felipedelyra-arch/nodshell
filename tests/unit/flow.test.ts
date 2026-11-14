import { describe, expect, it } from 'vitest'
import { FlowEngine, INBOX_MAX, mergeMarks, PAUSED_BY_USER, type AgentView, type FlowEvent, type FlowPorts } from '../../src/main/application/flow'
import { AgentError, HeldInput } from '../../src/main/domain/agent'
import { BURST_MAX, BURST_WINDOW_MS, matchesCondition, renderTemplate } from '../../src/main/domain/edge'
import { PROMPT_MAX } from '../../src/shared/agent'
import { DEFAULT_TEMPLATE } from '../../src/shared/flow'

type A = AgentView & { ownerId: number }

function world() {
  const agents = new Map<string, A>()
  const groups = new Map<string, { id: string; ownerId: number; name: string; memberIds: string[] }>()
  const squads = new Map<string, { ownerId: number; orchestratorId: string }>()
  const last = new Map<string, string>()
  const unavailable = new Map<string, string>()
  /** idle unless set; `busy` = working or waiting */
  const busy = new Set<string>()
  const opts = { paused: false, startOnDeliver: false, hold: undefined as string | undefined, fail: undefined as string | undefined }
  const tracked: [string, string[], string][] = []
  const delivered: { to: string; text: string }[] = []
  const events: FlowEvent[] = []
  const clock = { now: 0 }
  let n = 0
  const ports: FlowPorts = {
    agent: (o, id) => {
      const a = agents.get(id)
      return a?.ownerId === o ? a : undefined
    },
    group: (o, id) => {
      const g = groups.get(id)
      return g?.ownerId === o ? g : undefined
    },
    groupOf: (id) => [...groups.values()].find((g) => g.memberIds.includes(id)),
    squad: (o, id) => {
      const s = squads.get(id)
      return s?.ownerId === o ? s : undefined
    },
    lastMessage: async (_o, id) => last.get(id) ?? null,
    readiness: (_o, id) => (unavailable.has(id) ? { refused: unavailable.get(id)! } : opts.paused ? { refused: 'is paused' } : busy.has(id) ? 'busy' : 'idle'),
    deliver: async (_o, id, text) => {
      const why = unavailable.get(id)
      if (why) throw new AgentError(why)
      if (opts.hold) throw new HeldInput(opts.hold)
      if (opts.fail) throw new AgentError(opts.fail)
      delivered.push({ to: id, text })
      if (opts.startOnDeliver) busy.add(id) // its UserPromptSubmit: the turn runs
    },
    now: () => clock.now,
    emit: (_o, e) => void events.push(e),
    track: (id, tags, e) => void tracked.push([id, tags, e]),
  }
  const flow = new FlowEngine(ports, () => `e${++n}`)
  const agent = (id: string, name: string, role = 'frontend', workspaceId = 'w1', ownerId = 1) => agents.set(id, { id, name, role, workspaceId, ownerId })
  /** the agent's turn ends with `msg`: it is idle again (Stop) */
  const stop = async (id: string, msg = `reply of ${id}`) => {
    last.set(id, msg)
    busy.delete(id)
    await flow.onIdle(agents.get(id)?.ownerId ?? 1, id, true)
  }
  const to = () => delivered.map((d) => d.to)
  const paused = () => events.filter((e): e is Extract<FlowEvent, { type: 'paused' }> => e.type === 'paused')
  const ag = (id: string) => ({ kind: 'agent' as const, id })
  return { flow, agents, groups, squads, unavailable, busy, opts, delivered, events, clock, agent, stop, to, paused, ag, tracked }
}

describe('edge templates and conditions (domain)', () => {
  it('fills the placeholders in one pass: a placeholder inside the message is never expanded', () => {
    expect(renderTemplate('{name} ({role}, {group}): {message} / {message}', { message: 'hi {name}', name: 'Zoe', role: 'frontend', group: 'Frontend' })).toBe('Zoe (frontend, Frontend): hi {name} / hi {name}')
    expect(renderTemplate(DEFAULT_TEMPLATE, { message: 'done', name: 'Zoe', role: 'frontend', group: '' })).toBe('From Zoe (frontend):\ndone')
  })
  it('cuts a long message so the prompt stays within the limit, and says so', () => {
    const out = renderTemplate('Reply: {message}', { message: 'x'.repeat(PROMPT_MAX * 2), name: 'Zoe', role: 'r', group: '' })
    expect(out.length).toBeLessThanOrEqual(PROMPT_MAX)
    expect(out.startsWith('Reply: xxx')).toBe(true)
    expect(out).toMatch(/\[message truncated, it had 40000 characters\]$/)
    expect(renderTemplate('{message}{message}', { message: 'y'.repeat(PROMPT_MAX), name: '', role: '', group: '' }, 100).length).toBeLessThanOrEqual(100)
  })
  it('a condition is a case-insensitive substring, never a pattern; empty means always', () => {
    expect(matchesCondition('All tests PASS', 'pass')).toBe(true)
    expect(matchesCondition('All tests fail', 'pass')).toBe(false)
    expect(matchesCondition('a.b', '.*')).toBe(false)
    expect(matchesCondition('anything', '')).toBe(true)
  })
})

describe('FlowEngine', () => {
  it('Stop -> last message -> template -> injected into the target; the edge fires', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo', 'reviewer')
    const e = w.flow.create(1, w.ag('a'), w.ag('b'))
    expect(e).toMatchObject({ workspaceId: 'w1', template: DEFAULT_TEMPLATE, condition: '', paused: null })
    await w.stop('a', 'the diff is ready')
    expect(w.delivered).toEqual([{ to: 'b', text: 'From Zoe (frontend):\nthe diff is ready' }])
    expect(w.events).toContainEqual({ type: 'fired', id: e.id })
    await w.stop('b') // no edge leaves b
    expect(w.delivered).toHaveLength(1)
  })

  it('injects only when the condition is met', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    const e = w.flow.create(1, w.ag('a'), w.ag('b'))
    w.flow.update(1, e.id, { condition: 'READY', template: '{name}: {message}' })
    await w.stop('a', 'not yet')
    expect(w.delivered).toEqual([])
    await w.stop('a', 'it is ready now')
    expect(w.delivered).toEqual([{ to: 'b', text: 'Zoe: it is ready now' }])
  })

  it('a group source fires for any member; a group target reaches every member but the sender; a squad target reaches its Orchestrator', async () => {
    const w = world()
    w.agent('f1', 'Zoe')
    w.agent('f2', 'Pip')
    w.agent('r1', 'Leo', 'reviewer')
    w.agent('r2', 'Ada', 'reviewer')
    w.agent('o', 'Max', 'orchestrator')
    w.groups.set('gf', { id: 'gf', ownerId: 1, name: 'Frontend', memberIds: ['f1', 'f2'] })
    w.groups.set('gr', { id: 'gr', ownerId: 1, name: 'Reviewers', memberIds: ['r1', 'r2'] })
    w.squads.set('q', { ownerId: 1, orchestratorId: 'o' })
    w.flow.create(1, { kind: 'group', id: 'gf' }, { kind: 'group', id: 'gr' })
    w.flow.create(1, { kind: 'group', id: 'gf' }, { kind: 'squad', id: 'q' })
    w.flow.update(1, w.flow.list(1)[0]!.id, { template: '{group}/{name}: {message}' })
    await w.stop('f2', 'css done')
    expect(w.delivered).toEqual([
      { to: 'r1', text: 'Frontend/Pip: css done' },
      { to: 'r2', text: 'Frontend/Pip: css done' },
      { to: 'o', text: 'From Pip (frontend):\ncss done' },
    ])
    // a member reaching its own group only reaches the others
    w.delivered.length = 0
    w.flow.create(1, w.ag('r1'), { kind: 'group', id: 'gr' })
    await w.stop('r1')
    expect(w.to()).toEqual(['r2'])
  })

  it('skips a target that is starting, exited or paused, says why, and still reaches the others', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.agent('c', 'Ada')
    w.groups.set('g', { id: 'g', ownerId: 1, name: 'Reviewers', memberIds: ['b', 'c'] })
    const e = w.flow.create(1, w.ag('a'), { kind: 'group', id: 'g' })
    w.unavailable.set('b', 'is still starting')
    await w.stop('a')
    expect(w.to()).toEqual(['c'])
    expect(w.flow.list(1)[0]!.note).toBe('Not delivered, Leo is still starting')
    w.unavailable.set('c', 'is paused')
    w.delivered.length = 0
    await w.stop('a')
    expect(w.delivered).toEqual([])
    expect(w.events.filter((x) => x.type === 'fired' && x.id === e.id)).toHaveLength(1) // only the run that reached someone
    expect(w.flow.list(1)[0]!.note).toBe('Not delivered, Leo is still starting; Ada is paused')
  })

  it('a chain stops after 6 hops: the edge that would make the 7th pauses, with the reason', async () => {
    const w = world()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    ids.forEach((id, i) => w.agent(id, `N${'abcdefgh'[i]}x`))
    for (let i = 0; i < 7; i++) w.flow.create(1, w.ag(ids[i]!), w.ag(ids[i + 1]!))
    for (const id of ids.slice(0, 7)) await w.stop(id)
    expect(w.to()).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
    const last = w.flow.list(1)[6]!
    expect(last.paused).toBe('Stopped after 6 hops in one chain')
    expect(w.paused()).toEqual([{ type: 'paused', id: last.id, reason: 'Stopped after 6 hops in one chain' }])
    expect(w.flow.list(1).filter((e) => e.paused)).toHaveLength(1)
  })

  it('A -> B -> A: the third pass of the same edge in one chain is a loop and pauses that edge only', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    const ab = w.flow.create(1, w.ag('a'), w.ag('b'))
    const ba = w.flow.create(1, w.ag('b'), w.ag('a'))
    for (const id of ['a', 'b', 'a', 'b', 'a']) await w.stop(id)
    expect(w.to()).toEqual(['b', 'a', 'b', 'a'])
    expect(w.flow.list(1).find((e) => e.id === ab.id)!.paused).toBe('Loop detected, this edge fired 3 times in one chain')
    expect(w.flow.list(1).find((e) => e.id === ba.id)!.paused).toBeNull()
    expect(w.paused().map((p) => p.id)).toEqual([ab.id])
    // resumed by the user: active again
    w.flow.update(1, ab.id, { paused: false })
    expect(w.flow.list(1).find((e) => e.id === ab.id)).toMatchObject({ paused: null, note: null })
  })

  it('a prompt from the user starts a new chain', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.flow.create(1, w.ag('a'), w.ag('b'))
    w.flow.create(1, w.ag('b'), w.ag('a'))
    for (const id of ['a', 'b', 'a']) await w.stop(id) // a->b twice, b->a once in this chain
    w.flow.userPrompt('b') // the user typed to b: its next turn is a fresh chain
    for (const id of ['b', 'a', 'b', 'a']) await w.stop(id)
    expect(w.paused()).toEqual([])
    expect(w.to()).toHaveLength(7)
  })

  it(`more than ${BURST_MAX} injections in 60 s pause every flow, with the reason; Resume all restarts the count`, async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.flow.create(1, w.ag('a'), w.ag('b'))
    for (let i = 0; i < BURST_MAX + 1; i++) {
      w.flow.userPrompt('a') // each one a new chain: no hop or loop guard involved
      w.clock.now += 1000
      await w.stop('a')
    }
    expect(w.delivered).toHaveLength(BURST_MAX)
    expect(w.flow.flowsPaused(1)).toBe(true)
    expect(w.paused()).toEqual([{ type: 'paused', id: null, reason: `More than ${BURST_MAX} messages in 60 s, all flows paused` }])
    await w.stop('a')
    expect(w.delivered).toHaveLength(BURST_MAX)
    w.flow.resumeAll(1)
    await w.stop('a')
    expect(w.delivered).toHaveLength(BURST_MAX + 1)
  })

  it('injections older than the window do not count toward the burst', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.flow.create(1, w.ag('a'), w.ag('b'))
    for (let i = 0; i < BURST_MAX * 2; i++) {
      w.flow.userPrompt('a')
      w.clock.now += BURST_WINDOW_MS / 10
      await w.stop('a')
    }
    expect(w.delivered).toHaveLength(BURST_MAX * 2)
    expect(w.flow.flowsPaused(1)).toBe(false)
  })

  it('the kill switch (Pause all) stops every flow until Resume all, for that window only', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.agent('x', 'Ada', 'frontend', 'w9', 2)
    w.agent('y', 'Bo', 'frontend', 'w9', 2)
    w.flow.create(1, w.ag('a'), w.ag('b'))
    w.flow.create(2, w.ag('x'), w.ag('y'))
    w.flow.pauseAll(1)
    await w.stop('a')
    await w.stop('x')
    expect(w.to()).toEqual(['y'])
    w.flow.resumeAll(1)
    await w.stop('a')
    expect(w.to()).toEqual(['y', 'b'])
  })

  it('an edge paused by the user does not fire', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    const e = w.flow.create(1, w.ag('a'), w.ag('b'))
    expect(w.flow.update(1, e.id, { paused: true }).paused).toBe(PAUSED_BY_USER)
    await w.stop('a')
    expect(w.delivered).toEqual([])
  })

  it('connects only two different, existing ends of one window and one workspace, once', () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.agent('c', 'Ada', 'frontend', 'w2')
    w.agent('o', 'Max', 'orchestrator')
    w.agent('x', 'Bo', 'frontend', 'w1', 2)
    w.squads.set('q', { ownerId: 1, orchestratorId: 'o' })
    expect(() => w.flow.create(1, w.ag('a'), w.ag('a'))).toThrow('cannot connect to itself')
    expect(() => w.flow.create(1, w.ag('o'), { kind: 'squad', id: 'q' })).toThrow('cannot connect to itself')
    expect(() => w.flow.create(1, w.ag('a'), w.ag('c'))).toThrow('same workspace')
    expect(() => w.flow.create(1, w.ag('a'), w.ag('x'))).toThrow('Unknown card') // another window's agent
    expect(() => w.flow.create(2, w.ag('x'), w.ag('a'))).toThrow('Unknown card')
    expect(() => w.flow.create(1, w.ag('a'), w.ag('nope'))).toThrow('Unknown card')
    expect(() => w.flow.create(1, { kind: 'group', id: 'missing' }, w.ag('a'))).toThrow('Unknown card')
    w.flow.create(1, w.ag('a'), w.ag('b'))
    expect(() => w.flow.create(1, w.ag('a'), w.ag('b'))).toThrow('already connected')
    w.flow.create(1, w.ag('b'), w.ag('a')) // the other direction is another edge
    expect(() => w.flow.update(2, w.flow.list(1)[0]!.id, { paused: true })).toThrow('Unknown edge')
    expect(() => w.flow.remove(2, w.flow.list(1)[0]!.id)).toThrow('Unknown edge')
  })

  it('drops the edges that lost an end: agent closed, group dissolved, squad gone, window closed', () => {
    const w = world()
    for (const [id, n] of [['a', 'Zoe'], ['b', 'Leo'], ['c', 'Ada'], ['o', 'Max']]) w.agent(id!, n!)
    w.groups.set('g', { id: 'g', ownerId: 1, name: 'G', memberIds: ['b', 'c'] })
    w.squads.set('q', { ownerId: 1, orchestratorId: 'o' })
    w.flow.create(1, w.ag('a'), w.ag('b'))
    w.flow.create(1, { kind: 'group', id: 'g' }, { kind: 'squad', id: 'q' })
    w.flow.create(1, w.ag('a'), w.ag('c'))
    const changes = () => w.events.filter((e) => e.type === 'changed').length
    const before = changes()
    w.flow.prune(1)
    expect(changes()).toBe(before) // nothing gone, nothing announced
    w.agents.delete('b') // closed; its group keeps c
    w.groups.get('g')!.memberIds = ['c']
    w.flow.prune(1)
    expect(w.flow.list(1).map((e) => e.target.id)).toEqual(['q', 'c'])
    w.squads.delete('q') // the Orchestrator closed
    w.flow.prune(1)
    expect(w.flow.list(1).map((e) => e.target.id)).toEqual(['c'])
    w.flow.dropOwner(1)
    expect(w.flow.list(1)).toEqual([])
  })

  it('send_message: same kill switch and burst guard; the recipient continues the sender\'s chain', async () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.agent('c', 'Ada')
    const b = w.agents.get('b')!
    w.unavailable.set('c', 'is still starting')
    expect(await w.flow.send(1, 'a', [b, w.agents.get('c')!], 'hi')).toEqual({ sent: ['Leo'], queued: [], skipped: ['Ada is still starting'] })
    expect(w.delivered).toEqual([{ to: 'b', text: 'hi' }])
    w.flow.pauseAll(1)
    await expect(w.flow.send(1, 'a', [b], 'hi')).rejects.toThrow('Flows are paused')
    w.flow.resumeAll(1)
    // a chain of messages: b (hop 1) -> a (2) -> b (3) ... the 7th hop is refused
    const order = ['a', 'b', 'a', 'b', 'a']
    for (let i = 0; i < order.length; i++) await w.flow.send(1, order[i - 1] ?? 'b', [w.agents.get(order[i]!)!], `m${i}`)
    await expect(w.flow.send(1, 'a', [b], 'too far')).rejects.toThrow('Chain limit reached (6 hops)')
  })
})

describe('FlowEngine queue: only an idle agent is ever written to', () => {
  const two = () => {
    const w = world()
    w.agent('a', 'Zoe')
    w.agent('b', 'Leo')
    w.agent('c', 'Ada')
    return w
  }

  it('a busy target (working, or waiting on a permission dialog) is never written to: the message waits and goes in one prompt when its turn ends', async () => {
    const w = two()
    w.flow.create(1, w.ag('a'), w.ag('b'))
    w.flow.create(1, w.ag('c'), w.ag('b'))
    w.busy.add('b')
    await w.stop('a', 'first')
    await w.stop('c', 'second')
    expect(w.delivered).toEqual([]) // nothing typed while busy
    expect(w.flow.queued('b')).toBe(2)
    expect(w.events.filter((e) => e.type === 'fired')).toHaveLength(2) // queued counts as reached
    await w.stop('b')
    expect(w.delivered).toEqual([{ to: 'b', text: 'From Zoe (frontend):\nfirst\n\nFrom Ada (frontend):\nsecond' }])
    expect(w.flow.queued('b')).toBe(0)
  })

  it('send_message says whether it was delivered or queued', async () => {
    const w = two()
    w.busy.add('c')
    expect(await w.flow.send(1, 'a', [w.agents.get('b')!, w.agents.get('c')!], 'hi')).toEqual({ sent: ['Leo'], queued: ['Ada'], skipped: [] })
    expect(w.to()).toEqual(['b'])
  })

  it(`refuses beyond ${INBOX_MAX} waiting messages or the size limit, with a clear reason`, async () => {
    const w = two()
    w.busy.add('b')
    for (let i = 0; i < INBOX_MAX; i++) expect(await w.flow.send(1, 'a', [w.agents.get('b')!], `m${i}`)).toMatchObject({ queued: ['Leo'] })
    expect(await w.flow.send(1, 'a', [w.agents.get('b')!], 'one more')).toEqual({ sent: [], queued: [], skipped: ['Leo has too many messages waiting'] })
    const big = two()
    big.busy.add('b')
    for (let i = 0; i < 4; i++) await big.flow.send(1, 'a', [big.agents.get('b')!], 'x'.repeat(PROMPT_MAX))
    expect((await big.flow.send(1, 'a', [big.agents.get('b')!], 'y')).skipped).toEqual(['Leo has too many messages waiting'])
    // what does not fit in one prompt waits for the next idle
    big.busy.delete('b')
    big.opts.startOnDeliver = true
    await big.flow.onIdle(1, 'b', false)
    expect(big.delivered).toHaveLength(1)
    expect(big.delivered[0]!.text.length).toBeLessThanOrEqual(PROMPT_MAX)
    expect(big.flow.queued('b')).toBe(3)
  })

  it('held during Pause all (kill switch or processes) and delivered after Resume all; discarded when the agent closes', async () => {
    const w = two()
    w.busy.add('b')
    await w.flow.send(1, 'a', [w.agents.get('b')!], 'later')
    w.flow.pauseAll(1)
    w.opts.paused = true
    await w.stop('b')
    expect(w.delivered).toEqual([])
    w.opts.paused = false
    w.flow.resumeAll(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(w.delivered).toEqual([{ to: 'b', text: 'later' }])
    w.busy.add('c')
    await w.flow.send(1, 'a', [w.agents.get('c')!], 'never')
    w.agents.delete('c')
    w.flow.prune(1)
    expect(w.flow.queued('c')).toBe(0)
    w.busy.add('b')
    await w.flow.send(1, 'a', [w.agents.get('b')!], 'gone with the window')
    w.flow.dropOwner(1)
    expect(w.flow.queued('b')).toBe(0)
  })

  it('a prompt pasted but not submitted (the agent stopped being idle before the Enter) is never sent again', async () => {
    const w = two()
    w.opts.hold = 'is busy, the text was left unsent in its input'
    expect(await w.flow.send(1, 'a', [w.agents.get('b')!], 'once')).toEqual({ sent: [], queued: [], skipped: ['Leo is busy, the text was left unsent in its input'] })
    expect(w.flow.queued('b')).toBe(0)
    // refused before the paste (nothing written): it waits for the next idle
    w.opts.hold = undefined
    w.unavailable.set('c', 'is paused')
    expect((await w.flow.send(1, 'a', [w.agents.get('c')!], 'x')).skipped).toEqual(['Ada is paused'])
  })

  it('a task tag follows its message: queued, delivered right before the paste, put back on a refusal, dropped when left unsent', async () => {
    const w = two()
    await w.flow.send(1, 'a', [w.agents.get('b')!], 'now', 't1')
    expect(w.tracked).toEqual([['b', ['t1'], 'queued'], ['b', ['t1'], 'delivered']])
    w.tracked.length = 0
    w.busy.add('c')
    await w.flow.send(1, 'a', [w.agents.get('c')!], 'later', 't2')
    await w.flow.send(1, 'a', [w.agents.get('c')!], 'untagged')
    await w.flow.send(1, 'a', [w.agents.get('c')!], 'later too', 't3')
    expect(w.tracked).toEqual([['c', ['t2'], 'queued'], ['c', ['t3'], 'queued']])
    w.opts.fail = 'is not running'
    await w.stop('c')
    expect(w.tracked.slice(2)).toEqual([['c', ['t2', 't3'], 'delivered'], ['c', ['t2', 't3'], 'returned']]) // one prompt; back in the queue
    expect(w.flow.queued('c')).toBe(3)
    w.opts.fail = undefined
    w.opts.hold = 'is busy, the text was left unsent in its input'
    await w.flow.onIdle(1, 'c', false)
    expect(w.tracked.at(-1)).toEqual(['c', ['t2', 't3'], 'dropped'])
    expect(w.flow.queued('c')).toBe(0)
    // an edge's injection carries no tag
    w.tracked.length = 0
    w.opts.hold = undefined
    w.flow.create(1, w.ag('a'), w.ag('b'))
    await w.stop('a')
    expect(w.tracked).toEqual([])
  })

  it('hold: a just-spawned agent\'s task waits while it starts and goes, alone, on its first idle; Pause all holds it; it counts toward the burst guard', async () => {
    const w = two()
    w.agent('n', 'Uma', 'backend')
    w.unavailable.set('n', 'is still starting')
    w.flow.hold(1, 'a', w.agents.get('n')!, 'From Zoe (orchestrator):\nwrite the API', 't1')
    expect(w.delivered).toEqual([]) // never typed while starting (its trust dialog)
    expect(w.flow.queued('n')).toBe(1)
    expect(w.tracked).toEqual([['n', ['t1'], 'queued']])
    w.unavailable.delete('n')
    w.flow.pauseAll(1)
    await w.flow.onIdle(1, 'n', false)
    expect(w.delivered).toEqual([])
    w.flow.resumeAll(1)
    await Promise.resolve()
    expect(w.delivered).toEqual([{ to: 'n', text: 'From Zoe (orchestrator):\nwrite the API' }])
    expect(w.tracked.at(-1)).toEqual(['n', ['t1'], 'delivered'])
    // the spawn request and the task each count once
    const b = two()
    b.agent('n', 'Uma', 'backend')
    for (let i = 0; i < BURST_MAX; i++) b.flow.charge(1)
    expect(() => b.flow.hold(1, 'a', b.agents.get('n')!, 'one too many', 't2')).toThrow('Too many messages, all flows paused')
    expect(() => b.flow.charge(1)).toThrow('Flows are paused')
    expect(b.flow.queued('n')).toBe(0)
    expect(b.paused()).toHaveLength(1)
    expect(b.flow.flowsPaused(1)).toBe(true)
  })

  it('joined messages continue the highest hop and the summed firings', async () => {
    const m = (hop: number, fired: [string, number][]) => ({ ownerId: 1, hop, chain: { fired: new Map(fired) } })
    const one = m(2, [['e1', 1]])
    expect(mergeMarks([one])).toBe(one) // alone: the same chain, shared with its siblings
    const j = mergeMarks([one, m(5, [['e1', 1], ['e2', 1]]), m(1, [['e2', 1]])])
    expect(j.hop).toBe(5)
    expect([...j.chain.fired]).toEqual([['e1', 2], ['e2', 2]])
    // end to end: two messages of one chain wait for a busy agent; joined, the next pass of that edge is its third
    const w = two()
    const ab = w.flow.create(1, w.ag('a'), w.ag('b'))
    const ac = w.flow.create(1, w.ag('a'), w.ag('c'))
    w.flow.create(1, w.ag('b'), w.ag('a'))
    w.flow.create(1, w.ag('c'), w.ag('a'))
    await w.stop('a') // ab and ac fire once (one chain)
    w.busy.add('a')
    await w.stop('b') // both replies wait for a, each carrying ab = 1
    await w.stop('c')
    expect(w.flow.queued('a')).toBe(2)
    await w.stop('a') // a runs the joined prompt... (its Stop here consumes the old turn)
    expect(w.delivered.at(-1)!.to).toBe('a')
    await w.stop('a') // ...and this Stop ends the joined turn: ab = 1 + 1 + 1, a loop
    expect(w.flow.list(1).find((e) => e.id === ab.id)!.paused).toMatch(/Loop detected/)
    expect(w.flow.list(1).find((e) => e.id === ac.id)!.paused).toMatch(/Loop detected/)
  })

  it('two interlocking cycles (group -> Orchestrator, Orchestrator -> group) stop by themselves', async () => {
    const w = world()
    w.agent('m1', 'Zoe')
    w.agent('m2', 'Pip')
    w.agent('o', 'Max', 'orchestrator')
    w.groups.set('g', { id: 'g', ownerId: 1, name: 'Frontend', memberIds: ['m1', 'm2'] })
    w.squads.set('q', { ownerId: 1, orchestratorId: 'o' })
    w.flow.create(1, { kind: 'group', id: 'g' }, { kind: 'squad', id: 'q' })
    w.flow.create(1, w.ag('o'), { kind: 'group', id: 'g' })
    w.opts.startOnDeliver = true
    w.busy.add('m1')
    w.busy.add('m2') // the user prompted both members
    // run the board: every working agent ends its turn, the oldest first, until nothing runs
    let turns = 0
    while (w.busy.size > 0 && turns < 200) {
      const next = [...w.busy][0]!
      await w.stop(next)
      turns++
    }
    expect(turns).toBeLessThan(40)
    expect(w.paused().length).toBeGreaterThan(0)
    expect(w.delivered.length).toBeLessThan(30)
  })
})

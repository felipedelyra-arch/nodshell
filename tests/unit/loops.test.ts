import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowEngine, type FlowPorts } from '../../src/main/application/flow'
import { LoopEngine, PAUSED_BY_YOU, remapLoops, type LoopEvent } from '../../src/main/application/loops'
import type { AgentState } from '../../src/main/domain/adapter'
import { BURST_MAX } from '../../src/main/domain/edge'
import { goalReached, normalizeLoop, OutputMatcher, stripAnsi, type LoopInput, type SavedLoop } from '../../src/main/domain/loop'
import { GOAL_REACHED, PAUSED_ON_REOPEN } from '../../src/shared/loop'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = uuid(1)
const B = uuid(2)
const CON = uuid(3)
const OTHER_WS = uuid(4)

afterEach(() => {
  vi.useRealTimers()
})

/** A FlowEngine and a LoopEngine wired as in main, with fake timers and agents whose state the test drives. */
function world(msPerSec = 1000) {
  vi.useFakeTimers()
  const states = new Map<string, AgentState>()
  const ws = new Map<string, string>([[CON, 'w1'], [OTHER_WS, 'w2']])
  const consoles = new Set([CON, OTHER_WS])
  const last = new Map<string, string>()
  const delivered: { to: string; text: string }[] = []
  const events: LoopEvent[] = []
  let paused = false
  let n = 0
  const view = (id: string) => (states.has(id) ? { id, name: id === A ? 'Zoe' : 'Leo', role: 'frontend', workspaceId: ws.get(id) ?? 'w1' } : undefined)
  const ports: FlowPorts = {
    agent: (_o, id) => view(id),
    group: () => undefined,
    groupOf: () => undefined,
    squad: () => undefined,
    lastMessage: async (_o, id) => last.get(id) ?? null,
    readiness: (_o, id) => {
      const s = states.get(id)
      if (!s || s === 'exited' || s === 'error') return { refused: 'is not running' }
      if (s === 'starting') return { refused: 'is still starting' }
      if (paused) return { refused: 'is paused' }
      return s === 'idle' ? 'idle' : 'busy'
    },
    deliver: async (_o, id, text) => {
      delivered.push({ to: id, text })
      setState(id, 'working') // its UserPromptSubmit: the turn runs
    },
    now: () => Date.now(),
    emit: () => undefined,
    track: (id, tags, e) => loops.track(id, tags, e),
  }
  const flow = new FlowEngine(ports, () => `e${++n}`)
  const loops: LoopEngine = new LoopEngine(
    {
      agent: (o, id) => (o === 1 && states.has(id) ? { id, name: view(id)!.name, state: states.get(id)! } : undefined),
      hasTerminal: (o, id) => o === 1 && (states.has(id) || consoles.has(id)),
      workspaceOf: (_o, id) => (states.has(id) || consoles.has(id) ? (ws.get(id) ?? 'w1') : undefined),
      lastMessage: async (_o, id) => last.get(id) ?? null,
      fire: (o, id, text, tag) => flow.loopPrompt(o, id, text, tag),
      withdraw: (id, tag) => flow.withdraw(id, tag),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      emit: (_o, e) => void events.push(e),
    },
    () => uuid(100 + ++n),
    msPerSec,
  )
  function setState(id: string, s: AgentState) {
    states.set(id, s)
    loops.onState(1, id, s)
  }
  /** the agent's turn ends with `msg` (Stop), in main's order: loops, then flows */
  const stop = async (id: string, msg = 'nothing yet') => {
    last.set(id, msg)
    setState(id, 'idle')
    await Promise.all([loops.onIdle(1, id, true), flow.onIdle(1, id, true)])
  }
  const advance = (sec: number) => vi.advanceTimersByTimeAsync(sec * msPerSec)
  const notices = () => events.flatMap((e) => (e.type === 'notice' ? [e.text] : []))
  return { flow, loops, states, delivered, events, setState, stop, advance, notices, setPaused: (v: boolean) => (paused = v) }
}

const idle = (afterSec = 30, extra: Partial<LoopInput> = {}): LoopInput => ({ prompt: 'run the tests', trigger: { kind: 'idle', afterSec }, goal: '', maxRuns: 20, ...extra })
const every = (everySec = 60, extra: Partial<LoopInput> = {}): LoopInput => ({ prompt: 'check the build', trigger: { kind: 'schedule', everySec }, goal: '', maxRuns: 20, ...extra })

describe('loop rules (domain)', () => {
  it('cleans the texts and checks every bound', () => {
    const l = normalizeLoop({ prompt: 'line 1\r\nline​ 2\u0007\tend', trigger: { kind: 'output', terminalId: CON, text: ' ERR‮OR\n ' }, goal: ' all\u0000 green ', maxRuns: 5 })
    expect(l).toEqual({ prompt: 'line 1\nline 2\tend', trigger: { kind: 'output', terminalId: CON, text: ' ERROR  ' }, goal: 'all green', maxRuns: 5 })
    expect(() => normalizeLoop(every(59))).toThrow(/between 60 and 86400/)
    expect(() => normalizeLoop(every(86_401))).toThrow(/between 60 and 86400/)
    expect(() => normalizeLoop(idle(29))).toThrow(/between 30 and 3600/)
    expect(() => normalizeLoop(idle(30.5))).toThrow(/between 30 and 3600/)
    expect(() => normalizeLoop(idle(30, { maxRuns: 0 }))).toThrow(/Max runs/)
    expect(() => normalizeLoop(idle(30, { maxRuns: 101 }))).toThrow(/Max runs/)
    expect(() => normalizeLoop(idle(30, { prompt: ' ​\u0001 ' }))).toThrow(/needs a prompt/)
    expect(() => normalizeLoop(idle(30, { goal: 'g'.repeat(201) }))).toThrow(/goal/)
    expect(() => normalizeLoop({ ...idle(), trigger: { kind: 'output', terminalId: CON, text: '\u0001' } })).toThrow(/which text/)
    expect(() => normalizeLoop({ ...idle(), trigger: { kind: 'output', terminalId: 'not-an-id', text: 'x' } })).toThrow(/Unknown terminal/)
  })
  it('the goal is a case-insensitive substring; no goal is never reached', () => {
    expect(goalReached('All tests PASS now', 'tests pass')).toBe(true)
    expect(goalReached('All tests fail', 'tests pass')).toBe(false)
    expect(goalReached('anything', '')).toBe(false)
    expect(goalReached('a.b', '.*')).toBe(false)
  })
  it('strips ANSI and finds a text cut between chunks, even inside an escape sequence, never twice for the same stretch', () => {
    expect(stripAnsi('\x1b[1;31mERR\x1b[0mOR\x1b]0;title\x07 done\r\n')).toBe('ERROR done\n')
    const m = new OutputMatcher('error')
    expect(m.feed('build: ER')).toBe(false)
    expect(m.feed('ROR at line 3')).toBe(true)
    expect(m.feed(' more output')).toBe(false) // the same stretch does not match again
    expect(m.feed('\x1b[31mer')).toBe(false)
    expect(m.feed('r\x1b[')).toBe(false)
    expect(m.feed('0mor')).toBe(true) // the colour code was cut between chunks
    expect(m.feed('nothing')).toBe(false)
  })
  it('a reopened board maps loops onto the new ids and drops those whose agent or watched terminal did not come back, or whose id is not valid', () => {
    const s = (id: number, agentId: string, terminalId?: string): SavedLoop => ({ id: uuid(id), workspaceId: 'w1', agentId, prompt: 'p', trigger: terminalId ? { kind: 'output', terminalId, text: 't' } : { kind: 'idle', afterSec: 30 }, goal: '', maxRuns: 3 })
    const ids = new Map([[A, uuid(51)], [CON, uuid(53)]])
    expect(remapLoops([s(1, A), s(2, B), s(3, A, CON), s(4, A, uuid(99)), { ...s(5, A), id: "x'; DROP TABLE loops;--" }], ids)).toEqual([
      { ...s(1, A), agentId: uuid(51) },
      { ...s(3, A, CON), agentId: uuid(51), trigger: { kind: 'output', terminalId: uuid(53), text: 't' } },
    ])
  })
})

describe('LoopEngine', () => {
  it('a schedule fires every N seconds and never piles up prompts while the agent is busy', async () => {
    const w = world()
    w.setState(A, 'working')
    w.loops.set(1, A, every(60))
    await w.advance(59)
    expect(w.flow.queued(A)).toBe(0)
    await w.advance(1)
    expect(w.flow.queued(A)).toBe(1) // queued until it is idle
    await w.advance(600)
    expect(w.flow.queued(A)).toBe(1) // ten more ticks, still one
    expect(w.delivered).toEqual([])
    await w.stop(A) // the turn the user started ends: the loop's prompt goes in
    expect(w.delivered).toEqual([{ to: A, text: 'check the build' }])
    await w.advance(120) // its own turn is still running: nothing more
    expect(w.flow.queued(A)).toBe(0)
    await w.stop(A)
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 1, state: 'active' })
    await w.advance(60)
    expect(w.delivered).toHaveLength(2)
  })

  it('idle fires only after N seconds resting in a row; any state change starts the count again', async () => {
    const w = world()
    w.setState(A, 'idle')
    w.loops.set(1, A, idle(30))
    await w.advance(29)
    w.setState(A, 'working')
    w.setState(A, 'idle')
    await w.advance(29)
    expect(w.delivered).toEqual([])
    await w.advance(1)
    expect(w.delivered).toEqual([{ to: A, text: 'run the tests' }])
    expect(w.states.get(A)).toBe('working')
    await w.advance(120) // working: no idle count
    expect(w.delivered).toHaveLength(1)
    await w.stop(A)
    await w.advance(30)
    expect(w.delivered).toHaveLength(2)
  })

  it('output fires on a text cut between chunks of a terminal of the same workspace, and respects the cooldown', async () => {
    const w = world()
    w.setState(A, 'idle')
    expect(() => w.loops.set(1, A, { ...idle(), trigger: { kind: 'output', terminalId: OTHER_WS, text: 'FAILED' } })).toThrow(/same workspace/)
    expect(() => w.loops.set(1, A, { ...idle(), trigger: { kind: 'output', terminalId: uuid(77), text: 'FAILED' } })).toThrow(/same workspace/)
    w.loops.set(1, A, { prompt: 'fix it', trigger: { kind: 'output', terminalId: CON, text: 'FAILED' }, goal: '', maxRuns: 20 })
    w.loops.onOutput(1, B, 'FAILED') // another terminal
    w.loops.onOutput(2, CON, 'FAILED') // another window
    await w.advance(0)
    expect(w.delivered).toEqual([])
    w.loops.onOutput(1, CON, '3 tests FAI')
    w.loops.onOutput(1, CON, '\x1b[31mLED\x1b[0m\r\n')
    await w.advance(0)
    expect(w.delivered).toEqual([{ to: A, text: 'fix it' }])
    await w.stop(A)
    await w.advance(10)
    w.loops.onOutput(1, CON, 'FAILED again')
    await w.advance(0)
    expect(w.delivered).toHaveLength(1) // within 30 s of the last firing
    await w.advance(20)
    w.loops.onOutput(1, CON, 'FAILED once more')
    await w.advance(0)
    expect(w.delivered).toHaveLength(2)
  })

  it('a reply with the goal ends the loop (done, said once) and nothing fires afterwards', async () => {
    const w = world()
    w.setState(A, 'idle')
    w.loops.set(1, A, idle(30, { goal: 'All Green' }))
    await w.advance(30)
    await w.stop(A, 'still 2 failures')
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 1, state: 'active', reason: null })
    await w.advance(30)
    await w.stop(A, 'done: all green!')
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 2, state: 'done', reason: GOAL_REACHED })
    expect(w.notices()).toEqual(['Loop of Zoe done, goal reached after 2 runs'])
    await w.advance(600)
    expect(w.delivered).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maxRuns pauses it and says why; resuming starts from zero', async () => {
    const w = world()
    w.setState(A, 'idle')
    const l = w.loops.set(1, A, idle(30, { maxRuns: 2 }))
    for (let i = 0; i < 2; i++) {
      await w.advance(30)
      await w.stop(A)
    }
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 2, state: 'paused', reason: 'Stopped after 2 runs' })
    expect(w.notices()).toEqual(['Loop of Zoe paused, stopped after 2 runs'])
    await w.advance(300)
    expect(w.delivered).toHaveLength(2)
    w.loops.update(1, l.id, false)
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 0, state: 'active', reason: null })
    await w.advance(30)
    expect(w.delivered).toHaveLength(3)
  })

  it('Pause all: nothing fires (the loop stays active) until Resume all; paused time does not count as idle', async () => {
    const w = world()
    w.setState(A, 'idle')
    w.loops.set(1, A, idle(30))
    await w.advance(20)
    w.flow.pauseAll(1)
    w.setPaused(true)
    w.loops.restartIdle(1)
    await w.advance(300)
    expect(w.delivered).toEqual([])
    expect(w.flow.queued(A)).toBe(0)
    expect(w.loops.list(1)[0]!.state).toBe('active')
    w.setPaused(false)
    w.flow.resumeAll(1)
    w.loops.restartIdle(1)
    await w.advance(29)
    expect(w.delivered).toEqual([])
    await w.advance(1)
    expect(w.delivered).toHaveLength(1)
  })

  it('counts toward the burst guard: one firing too many pauses every flow and the loop waits', async () => {
    const w = world()
    w.setState(A, 'idle')
    w.loops.set(1, A, every(60))
    await w.advance(59)
    for (let i = 0; i < BURST_MAX; i++) w.flow.charge(1)
    await w.advance(1)
    expect(w.flow.flowsPaused(1)).toBe(true)
    expect(w.delivered).toEqual([])
    await w.advance(120)
    expect(w.delivered).toEqual([])
    expect(w.loops.list(1)[0]!.state).toBe('active')
    w.flow.resumeAll(1)
    await w.advance(60)
    expect(w.delivered).toHaveLength(1)
  })

  it('never types into an agent that is starting or needs the user: refused while starting, held while waiting', async () => {
    const w = world()
    w.setState(A, 'starting')
    w.loops.set(1, A, every(60))
    await w.advance(60)
    expect(w.flow.queued(A)).toBe(0)
    w.setState(A, 'waiting')
    await w.advance(60)
    expect(w.flow.queued(A)).toBe(1)
    expect(w.delivered).toEqual([])
    await w.stop(A) // back to resting: delivered then
    expect(w.delivered).toEqual([{ to: A, text: 'check the build' }])
  })

  it('pausing takes back a prompt still queued; removing, closing the agent or the window leaves no timer', async () => {
    const w = world()
    w.setState(A, 'working')
    w.setState(B, 'idle')
    const l = w.loops.set(1, A, every(60))
    await w.advance(60)
    expect(w.flow.queued(A)).toBe(1)
    w.loops.update(1, l.id, true)
    expect(w.flow.queued(A)).toBe(0)
    expect(w.loops.list(1)[0]).toMatchObject({ state: 'paused', reason: PAUSED_BY_YOU })
    expect(vi.getTimerCount()).toBe(0)
    w.loops.update(1, l.id, false)
    w.loops.remove(1, l.id)
    expect(w.loops.list(1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    w.loops.set(1, A, every(60))
    w.loops.set(1, B, idle(30))
    w.setState(A, 'exited')
    expect(w.loops.list(1).map((x) => x.agentId)).toEqual([B])
    w.states.delete(B) // closed: its card is gone
    w.loops.prune(1)
    expect(w.loops.list(1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    w.setState(A, 'idle')
    w.loops.set(1, A, every(60))
    w.loops.dropOwner(1)
    expect(w.loops.list(1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a loop watching a terminal that closes goes, and the user is told', () => {
    const w = world()
    w.setState(A, 'idle')
    w.setState(B, 'idle')
    w.loops.set(1, A, { prompt: 'p', trigger: { kind: 'output', terminalId: B, text: 'x' }, goal: '', maxRuns: 1 })
    w.states.delete(B)
    w.loops.prune(1)
    expect(w.loops.list(1)).toEqual([])
    expect(w.notices()).toEqual(['Loop of Zoe removed, the terminal it watched was closed'])
  })

  it('one loop per agent (a new one replaces it), only on agents of the window, never on a console; restore comes back paused', async () => {
    const w = world()
    w.setState(A, 'idle')
    const first = w.loops.set(1, A, every(60))
    const second = w.loops.set(1, A, idle(30))
    expect(w.loops.list(1)).toEqual([second])
    expect(second.id).not.toBe(first.id)
    expect(() => w.loops.set(2, A, idle())).toThrow(/running agent/)
    expect(() => w.loops.set(1, CON, idle())).toThrow(/running agent/)
    expect(() => w.loops.update(2, second.id, true)).toThrow(/Unknown loop/)
    const r = w.loops.restore(1, { id: uuid(9), workspaceId: 'w1', agentId: A, ...idle(30, { goal: 'ok' }) })
    expect(r).toMatchObject({ id: uuid(9), state: 'paused', reason: PAUSED_ON_REOPEN, runs: 0, goal: 'ok' })
    await w.advance(300)
    expect(w.delivered).toEqual([])
  })

  it('a turn the loop started that ends without a Stop (interrupted, failed) still counts as a run and frees the loop; the goal is not read', async () => {
    const w = world()
    w.setState(A, 'idle')
    w.loops.set(1, A, idle(30, { goal: 'nothing yet' }))
    await w.advance(30)
    expect(w.delivered).toHaveLength(1)
    w.setState(A, 'idle')
    await w.loops.onIdle(1, A, false)
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 1, state: 'active' }) // 'nothing yet' would be the last reply: never read here
    await w.advance(30)
    expect(w.delivered).toHaveLength(2)
  })

  it('turns that keep failing without a Stop (rate limit, network) stop at maxRuns, paused and said', async () => {
    const w = world()
    w.setState(A, 'idle')
    w.loops.set(1, A, idle(30, { maxRuns: 2 }))
    for (let i = 0; i < 2; i++) {
      await w.advance(30)
      w.setState(A, 'idle') // StopFailure: back to resting without a Stop
      await w.loops.onIdle(1, A, false)
    }
    expect(w.loops.list(1)[0]).toMatchObject({ runs: 2, state: 'paused', reason: 'Stopped after 2 runs' })
    expect(w.notices()).toEqual(['Loop of Zoe paused, stopped after 2 runs'])
    await w.advance(600)
    expect(w.delivered).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses a loop that watches its own agent's terminal", () => {
    const w = world()
    w.setState(A, 'idle')
    expect(() => w.loops.set(1, A, { ...idle(), trigger: { kind: 'output', terminalId: A, text: 'done' } })).toThrow(/cannot watch its own agent/)
    expect(w.loops.list(1)).toEqual([])
  })

  it('scales its timers for tests', async () => {
    const w = world(10)
    w.setState(A, 'idle')
    w.loops.set(1, A, idle(30))
    await vi.advanceTimersByTimeAsync(299)
    expect(w.delivered).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(w.delivered).toHaveLength(1)
  })
})

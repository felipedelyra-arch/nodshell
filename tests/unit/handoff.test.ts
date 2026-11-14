import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowEngine, type FlowPorts } from '../../src/main/application/flow'
import { HandoffService, type HandoffEvent } from '../../src/main/application/handoff'
import type { AgentState } from '../../src/main/domain/adapter'
import { AgentError } from '../../src/main/domain/agent'
import { BRIEFING_REQUEST, briefingOf, handoffPrompt, SUMMARY_TIMEOUT_MS } from '../../src/main/domain/handoff'
import { PROMPT_MAX } from '../../src/shared/agent'
import { BRIEFING_MAX } from '../../src/shared/handoff'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = uuid(1)
const B = uuid(2)
const C = uuid(3) // another workspace
const SRC = { name: 'Zoe', role: 'frontend', branch: 'agent/frontend-1' }

afterEach(() => {
  vi.useRealTimers()
})

/** A FlowEngine and a HandoffService wired as in main, with fake timers and agents whose state the test drives. */
function world() {
  vi.useFakeTimers()
  const states = new Map<string, AgentState>([[A, 'idle'], [B, 'idle'], [C, 'idle']])
  const names: Record<string, string> = { [A]: 'Zoe', [B]: 'Leo', [C]: 'Pip' }
  const last = new Map<string, string>()
  const asked: { to: string; text: string }[] = []
  const delivered: { to: string; text: string }[] = []
  const events: HandoffEvent[] = []
  let paused = false
  let n = 0
  const view = (id: string) => (states.has(id) ? { id, name: names[id]!, role: 'frontend', workspaceId: id === C ? 'w2' : 'w1' } : undefined)
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
      states.set(id, 'working')
    },
    now: () => Date.now(),
    emit: () => undefined,
  }
  const flow = new FlowEngine(ports, () => `e${++n}`)
  const handoffs = new HandoffService(
    {
      agent: (o, id) => (o === 1 && states.has(id) ? { ...view(id)!, branch: `agent/frontend-${id.slice(-1)}`, state: states.get(id)! } : undefined),
      // as in main: a new chain, its Stop muted for the flows, written only while the agent rests
      ask: async (o, id, text) => {
        flow.userPrompt(id)
        flow.muteNextStop(o, id)
        try {
          await Promise.resolve() // the paste is queued: the state is checked again when it is written
          if (paused) throw new AgentError('Everything is paused')
          if (states.get(id) !== 'idle') throw new AgentError(`${names[id]} is busy`)
          asked.push({ to: id, text })
          states.set(id, 'working') // its UserPromptSubmit
        } catch (e) {
          flow.unmute(id)
          throw e
        }
      },
      pending: (_o, id) => flow.pending(id),
      release: (_o, id) => {
        if (states.get(id) === 'idle') flow.unmute(id)
      },
      lastMessage: async (_o, id) => last.get(id) ?? null,
      deliver: (o, id, text, tag) => flow.loopPrompt(o, id, text, tag),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      emit: (_o, e) => void events.push(e),
    },
    () => uuid(100 + ++n),
  )
  /** the agent's turn ends with `msg` (with a Stop, or without one: Esc, a failure), in main's order: handoffs, then flows */
  const stop = async (id: string, msg: string, byStop = true) => {
    last.set(id, msg)
    states.set(id, 'idle')
    await Promise.all([handoffs.onIdle(1, id, byStop), flow.onIdle(1, id, byStop)])
  }
  const notices = () => events.flatMap((e) => (e.notice ? [e.notice] : []))
  return { flow, handoffs, states, asked, delivered, notices, stop, setPaused: (v: boolean) => (paused = v) }
}

describe('handoff rules (domain)', () => {
  it('the final prompt is one text: header, blank line, briefing', () => {
    expect(handoffPrompt(SRC, '  did X\nnext: Y  ')).toBe('Handoff from Zoe (frontend, branch agent/frontend-1)\n\ndid X\nnext: Y')
  })
  it('cleans control and format characters and enforces the ceiling', () => {
    expect(handoffPrompt(SRC, 'a\u0007b​c‮\r\nd\te')).toBe('Handoff from Zoe (frontend, branch agent/frontend-1)\n\nabc\nd\te')
    expect(() => handoffPrompt(SRC, ' \u0001​ ')).toThrow(/empty/)
    expect(() => handoffPrompt(SRC, 'x'.repeat(BRIEFING_MAX + 1))).toThrow(new RegExp(`longer than ${BRIEFING_MAX}`))
    expect(handoffPrompt(SRC, 'x'.repeat(BRIEFING_MAX)).length).toBeLessThanOrEqual(PROMPT_MAX)
    expect(briefingOf(`\u0000 ${'y'.repeat(BRIEFING_MAX + 50)}`)).toHaveLength(BRIEFING_MAX)
  })
})

describe('HandoffService', () => {
  it('start asks the resting agent once, with the fixed request; refused when busy, itself, another workspace or already running', async () => {
    const w = world()
    await expect(w.handoffs.start(1, A, A)).rejects.toThrow(/itself/)
    await expect(w.handoffs.start(1, A, C)).rejects.toThrow(/same workspace/)
    await expect(w.handoffs.start(1, A, uuid(9))).rejects.toThrow(/Unknown agent/)
    await expect(w.handoffs.start(2, A, B)).rejects.toThrow(/Unknown agent/) // another window
    w.states.set(B, 'working')
    await expect(w.handoffs.start(1, B, A)).rejects.toThrow(/Leo must be resting/)
    const h = await w.handoffs.start(1, A, B)
    expect(h.state).toBe('summarizing')
    expect(w.asked).toEqual([{ to: A, text: BRIEFING_REQUEST }])
    w.states.set(A, 'idle')
    await expect(w.handoffs.start(1, A, B)).rejects.toThrow(/already has a handoff/)
    expect(w.asked).toHaveLength(1)
    expect(w.delivered).toEqual([])
  })

  it('a refused request leaves nothing behind (Pause all)', async () => {
    const w = world()
    w.setPaused(true)
    await expect(w.handoffs.start(1, A, B)).rejects.toThrow(/paused/)
    expect(w.handoffs.list(1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("on the source's Stop its last reply becomes the briefing (cleaned); nothing reaches the target yet", async () => {
    const w = world()
    const h = await w.handoffs.start(1, A, B)
    await w.stop(A, 'Did the page.​\nNext: tests.')
    expect(w.handoffs.list(1)).toEqual([{ ...h, state: 'ready', briefing: 'Did the page.\nNext: tests.' }])
    expect(vi.getTimerCount()).toBe(0)
    expect(w.delivered).toEqual([])
  })

  it('a turn without a Stop, an empty reply, a timeout or a closed agent cancels it with a notice and no timer left', async () => {
    const w = world()
    await w.handoffs.start(1, A, B)
    await w.stop(A, 'interrupted', false) // Esc or a failed turn
    expect(w.handoffs.list(1)).toEqual([])
    expect(w.notices().at(-1)).toMatch(/Handoff from Zoe cancelled, its turn ended without a summary/)
    expect(vi.getTimerCount()).toBe(0)

    w.states.set(A, 'idle')
    await w.handoffs.start(1, A, B)
    await w.stop(A, ' ​ ')
    expect(w.handoffs.list(1)).toEqual([])
    expect(w.notices().at(-1)).toMatch(/Zoe wrote no summary/)

    await w.handoffs.start(1, A, B)
    await vi.advanceTimersByTimeAsync(SUMMARY_TIMEOUT_MS)
    expect(w.handoffs.list(1)).toEqual([])
    expect(w.notices().at(-1)).toMatch(/no summary in 5 minutes/)
    expect(vi.getTimerCount()).toBe(0)

    w.states.set(A, 'idle')
    await w.handoffs.start(1, A, B)
    w.handoffs.onState(1, B, 'exited')
    expect(w.handoffs.list(1)).toEqual([])
    expect(w.notices().at(-1)).toMatch(/Zoe → Leo cancelled, Leo stopped/)
    expect(vi.getTimerCount()).toBe(0)

    w.states.set(A, 'idle')
    await w.handoffs.start(1, A, B)
    w.states.delete(A) // its card was closed
    w.handoffs.prune(1)
    expect(w.handoffs.list(1)).toEqual([])
    expect(w.notices().at(-1)).toMatch(/cancelled, an agent was closed/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('send before ready is refused; send delivers exactly one prompt to the target and the handoff is gone', async () => {
    const w = world()
    const h = await w.handoffs.start(1, A, B)
    await expect(w.handoffs.send(1, h.id, 'x')).rejects.toThrow(/not ready/)
    await w.stop(A, 'briefing')
    await expect(w.handoffs.send(2, h.id, 'x')).rejects.toThrow(/Unknown handoff/) // another window
    await expect(w.handoffs.send(1, h.id, 'y'.repeat(BRIEFING_MAX + 1))).rejects.toThrow(/longer than/)
    expect(await w.handoffs.send(1, h.id, 'Edited\nbriefing')).toBe('Handoff sent to Leo')
    expect(w.delivered).toEqual([{ to: B, text: 'Handoff from Zoe (frontend, branch agent/frontend-1)\n\nEdited\nbriefing' }])
    expect(w.handoffs.list(1)).toEqual([])
    await expect(w.handoffs.send(1, h.id, 'again')).rejects.toThrow(/Unknown handoff/)
    expect(w.delivered).toHaveLength(1)
  })

  it('a busy target gets it queued, as one prompt, when its turn ends', async () => {
    const w = world()
    const h = await w.handoffs.start(1, A, B)
    await w.stop(A, 'briefing')
    w.states.set(B, 'working')
    expect(await w.handoffs.send(1, h.id, 'briefing')).toBe('Handoff queued for Leo, delivered when its turn ends')
    expect(w.flow.queued(B)).toBe(1)
    expect(w.delivered).toEqual([])
    await w.stop(B, 'done')
    expect(w.delivered).toEqual([{ to: B, text: 'Handoff from Zoe (frontend, branch agent/frontend-1)\n\nbriefing' }])
  })

  it('Pause all or a starting target refuses the send and keeps the handoff to try again', async () => {
    const w = world()
    const h = await w.handoffs.start(1, A, B)
    await w.stop(A, 'briefing')
    w.flow.pauseAll(1)
    await expect(w.handoffs.send(1, h.id, 'briefing')).rejects.toThrow(/Not delivered, flows are paused/)
    w.flow.resumeAll(1)
    w.states.set(B, 'starting')
    await expect(w.handoffs.send(1, h.id, 'briefing')).rejects.toThrow(/Not delivered, Leo is still starting/)
    expect(w.delivered).toEqual([])
    expect(w.flow.queued(B)).toBe(0)
    expect(w.handoffs.list(1)).toHaveLength(1)
    w.states.set(B, 'idle')
    expect(await w.handoffs.send(1, h.id, 'briefing')).toBe('Handoff sent to Leo')
  })

  it('cancel delivers nothing, before or after the summary', async () => {
    const w = world()
    const h1 = await w.handoffs.start(1, A, B)
    w.handoffs.cancel(1, h1.id)
    expect(vi.getTimerCount()).toBe(0)
    await w.stop(A, 'late briefing') // the summary arrives after the cancel: ignored
    expect(w.handoffs.list(1)).toEqual([])
    const h2 = await w.handoffs.start(1, A, B)
    await w.stop(A, 'briefing')
    expect(() => w.handoffs.cancel(2, h2.id)).toThrow(/Unknown handoff/)
    w.handoffs.cancel(1, h2.id)
    expect(w.handoffs.list(1)).toEqual([])
    expect(w.delivered).toEqual([])
    expect(w.notices()).toEqual([])
  })

  it("the briefing's Stop fires no edge; the source's next Stop fires them again", async () => {
    const w = world()
    w.flow.create(1, { kind: 'agent', id: A }, { kind: 'agent', id: B })
    const h = await w.handoffs.start(1, A, B)
    await w.stop(A, 'SECRET briefing')
    expect(w.handoffs.list(1)[0]?.state).toBe('ready')
    expect(w.delivered).toEqual([]) // the edge A -> B did not pass the briefing on
    await w.handoffs.send(1, h.id, 'SECRET briefing')
    expect(w.delivered.filter((d) => d.text.includes('SECRET'))).toHaveLength(1) // only the Send
    await w.stop(B, 'ok')
    w.states.set(A, 'working')
    await w.stop(A, 'next reply')
    expect(w.delivered.at(-1)).toEqual({ to: B, text: expect.stringContaining('next reply') })
  })

  it('the mute never outlives the briefing turn: refused, cancelled while idle, timed out unsubmitted, or ended without a Stop', async () => {
    const w = world()
    w.flow.create(1, { kind: 'agent', id: A }, { kind: 'agent', id: B })
    const fired = () => w.delivered.filter((d) => d.to === B).length
    const turn = async (msg: string) => {
      w.states.set(A, 'working')
      await w.stop(A, msg)
      await w.stop(B, 'ok')
    }
    // refused (paused): nothing muted
    w.setPaused(true)
    await expect(w.handoffs.start(1, A, B)).rejects.toThrow(/paused/)
    w.setPaused(false)
    await turn('one')
    expect(fired()).toBe(1)
    // ended without a Stop: cancelled, the mute goes with that turn
    await w.handoffs.start(1, A, B)
    await w.stop(A, 'x', false)
    await turn('two')
    expect(fired()).toBe(2)
    // submitted but never started (still idle) and timed out: lifted
    await w.handoffs.start(1, A, B)
    w.states.set(A, 'idle')
    await vi.advanceTimersByTimeAsync(SUMMARY_TIMEOUT_MS)
    expect(w.handoffs.list(1)).toEqual([])
    await turn('three')
    expect(fired()).toBe(3)
    // cancelled by the user while the briefing turn runs: that turn's Stop still passes nothing on, the next one does
    await w.handoffs.start(1, A, B)
    w.handoffs.cancel(1, w.handoffs.list(1)[0]!.id)
    await w.stop(A, 'late briefing')
    expect(fired()).toBe(3)
    await turn('four')
    expect(fired()).toBe(4)
  })

  it('start is refused while something waits for the source or is being written to it', async () => {
    const w = world()
    w.states.set(A, 'working')
    await w.flow.loopPrompt(1, A, 'queued work', 'tag')
    w.states.set(A, 'idle') // idle, but its queue still holds a message
    await expect(w.handoffs.start(1, A, B)).rejects.toThrow(/Zoe has messages waiting, try again/)
    expect(w.asked).toEqual([])
    expect(w.handoffs.list(1)).toEqual([])
  })

  it('a busy source is refused by the request itself (checked again before the paste)', async () => {
    const w = world()
    // the source starts working between the check and the paste: the request is refused and nothing is left behind
    const start = w.handoffs.start(1, A, B)
    w.states.set(A, 'working')
    await expect(start).rejects.toThrow(/Zoe is busy/)
    expect(w.handoffs.list(1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel is refused while the send is under way', async () => {
    const w = world()
    const h = await w.handoffs.start(1, A, B)
    await w.stop(A, 'briefing')
    const sending = w.handoffs.send(1, h.id, 'briefing')
    expect(() => w.handoffs.cancel(1, h.id)).toThrow(/being sent/)
    expect(await sending).toBe('Handoff sent to Leo')
    expect(w.delivered).toHaveLength(1)
  })

  it('dropOwner forgets everything of the window silently, timers included', async () => {
    const w = world()
    await w.handoffs.start(1, A, B)
    w.handoffs.dropOwner(1)
    expect(w.handoffs.list(1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(w.notices()).toEqual([])
  })
})

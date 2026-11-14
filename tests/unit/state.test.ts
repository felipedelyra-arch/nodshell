import { describe, expect, it } from 'vitest'
import type { AgentState } from '../../src/main/domain/adapter'
import { nextState, type Transition } from '../../src/main/domain/state'
import { AGENT_STATES } from '../../src/shared/agent'

const run = (from: AgentState, ...ts: (Transition | null)[]) => ts.reduce<AgentState>((s, t) => nextState(s, t), from)

describe('agent state machine', () => {
  it.each<[AgentState, Transition, AgentState]>([
    ['starting', 'ready', 'idle'],
    ['starting', 'prompt', 'working'], // a prompt proves the session is ready even if SessionStart was missed
    ['starting', 'stop', 'idle'],
    ['starting', 'needs-input', 'starting'],
    ['starting', 'resumed', 'starting'],
    ['idle', 'prompt', 'working'],
    ['idle', 'ready', 'idle'],
    ['idle', 'needs-input', 'idle'],
    ['idle', 'resumed', 'idle'], // a late tool event never makes an idle agent busy
    ['working', 'needs-input', 'waiting'],
    ['working', 'stop', 'idle'],
    ['working', 'ready', 'working'], // compaction restarts the session mid-turn
    ['waiting', 'resumed', 'working'],
    ['waiting', 'stop', 'idle'],
    ['waiting', 'prompt', 'working'],
    ['working', { exit: 0 }, 'exited'],
    ['waiting', { exit: 1 }, 'error'],
    ['starting', { exit: 137 }, 'error'],
    ['working', 'at-input', 'idle'], // interrupted turn: no Stop, but the CLI sits at its input
    ['waiting', 'at-input', 'idle'],
    ['idle', 'at-input', 'idle'], // never moves an idle agent
    ['starting', 'at-input', 'starting'],
  ])('%s --%j--> %s', (from, t, to) => {
    expect(nextState(from, t)).toBe(to)
  })

  it('full turn with a permission request', () => {
    expect(run('starting', 'ready', 'prompt', 'needs-input', 'resumed', 'stop')).toBe('idle')
  })

  it('duplicates are idempotent', () => {
    expect(run('starting', 'ready', 'ready')).toBe('idle')
    expect(run('idle', 'prompt', 'prompt')).toBe('working')
    expect(run('working', 'stop', 'stop')).toBe('idle')
    expect(run('working', 'needs-input', 'needs-input')).toBe('waiting')
  })

  it('exit is final: late or out-of-order events after it change nothing', () => {
    for (const end of [{ exit: 0 }, { exit: 2 }] as Transition[]) {
      const s = nextState('working', end)
      for (const t of ['ready', 'prompt', 'stop', 'needs-input', 'resumed', 'at-input', { exit: 0 }, { exit: 1 }] as Transition[]) expect(nextState(s, t)).toBe(s)
    }
  })

  it('null (an unrelated event) never changes any state', () => {
    for (const s of AGENT_STATES) expect(nextState(s, null)).toBe(s)
  })
})

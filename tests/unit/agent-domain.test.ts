import { describe, expect, it } from 'vitest'
import { agentName, branchName, isValidAgentName, isValidRole, lowestFreeN, needsCloseConfirm, pickAgentName, slotOf } from '../../src/main/domain/agent'
import { AGENT_NAME_RE, AGENT_STATES, statusPill, STATUS_LABEL } from '../../src/shared/agent'
import { channels } from '../../src/shared/ipc/channels'

const id = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'

describe('role and branch names', () => {
  it.each(['a', 'frontend', 'qa-2', 'x'.repeat(24)])('accepts %s', (r) => {
    expect(isValidRole(r)).toBe(true)
    expect(branchName(r, 3)).toBe(`agent/${r}-3`)
  })
  it.each(['', '..', '../x', 'a/b', 'a b', '-a', 'Front', '1abc', 'a.b', 'a_b', 'x'.repeat(25), 'a\n', 'ação'])('rejects %j', (r) => {
    expect(isValidRole(r)).toBe(false)
    expect(() => branchName(r, 1)).toThrow()
  })
  it('rejects non-positive or non-integer n', () => {
    expect(() => agentName('a', 0)).toThrow()
    expect(() => agentName('a', 1.5)).toThrow()
  })
})

describe('slotOf / lowestFreeN', () => {
  it('reads n only for the same role', () => {
    expect(slotOf('agent/qa-2', 'qa')).toBe(2)
    expect(slotOf('qa-7', 'qa')).toBe(7)
    expect(slotOf('agent/qa-x-2', 'qa')).toBeUndefined()
    expect(slotOf('agent/qa-0', 'qa')).toBeUndefined()
    expect(slotOf('agent/qab-1', 'qa')).toBeUndefined()
  })
  it('picks the lowest free positive integer', () => {
    expect(lowestFreeN([])).toBe(1)
    expect(lowestFreeN([1, 2, 4])).toBe(3)
    expect(lowestFreeN([2, 3])).toBe(1)
    expect(lowestFreeN([1, 1, 2])).toBe(3)
  })
})

describe('agent channel schemas', () => {
  it('accepts valid input', () => {
    expect(channels['agent:prompt'].in.safeParse({ id, text: 'a\nb' }).success).toBe(true)
    expect(channels['workspace:pickRepo'].in.safeParse(undefined).success).toBe(true)
  })
  it.each([
    ['prompt empty', 'agent:prompt', { id, text: '' }],
    ['prompt too long', 'agent:prompt', { id, text: 'x'.repeat(20_001) }],
    ['close non-uuid', 'agent:close', { id: 'x' }],
    ['pickRepo with a path', 'workspace:pickRepo', { path: '/etc' }],
  ] as const)('rejects %s', (_n, ch, input) => {
    expect(channels[ch].in.safeParse(input).success).toBe(false)
  })
})

describe('short agent names', () => {
  const rngs = [() => 0, () => 0.5, () => 0.999]
  it('are valid, unique and case-insensitive among the taken ones', () => {
    const taken: string[] = []
    for (let i = 0; i < 40; i++) {
      const n = pickAgentName(taken, rngs[i % 3])
      expect(isValidAgentName(n)).toBe(true)
      expect(taken.map((t) => t.toLowerCase())).not.toContain(n.toLowerCase())
      taken.push(n)
    }
    expect(pickAgentName(['ZOE'], () => 0)).not.toBe('Zoe')
  })
  it('appends a number once the list is exhausted, and frees a closed name', () => {
    const taken: string[] = []
    for (;;) {
      const n = pickAgentName(taken)
      if (/\d$/.test(n)) {
        expect(n).toMatch(/^[A-Z][a-z]+2$/)
        break
      }
      taken.push(n)
    }
    expect(taken.length).toBeGreaterThanOrEqual(40)
    const closed = taken.filter((n) => n !== 'Zoe')
    expect(pickAgentName(closed, () => 0.999)).toBe('Zoe')
  })
  it('regex accepts names and rejects anything path-like', () => {
    for (const ok of ['Zoe', 'Leo', 'Pip', 'Zoe2', 'Opal12']) expect(AGENT_NAME_RE.test(ok)).toBe(true)
    for (const bad of ['', 'zoe', 'Z', 'Zoe1', 'Zoe0', 'Toolong', '../x', 'Zoe/1', 'Zoe-1', 'Zoe ', 'Zoé']) expect(AGENT_NAME_RE.test(bad)).toBe(false)
  })
  it('maps states to the user vocabulary', () => {
    expect(STATUS_LABEL).toMatchObject({ working: 'running', idle: 'resting', waiting: 'needs you', starting: 'starting', error: 'error', exited: 'exited', paused: 'paused' })
  })
})

describe('status pill and close confirmation', () => {
  it('only a running agent or console is orange; the rest is muted with the shared label', () => {
    expect(statusPill('working')).toEqual({ label: 'running', active: true })
    expect(statusPill('running')).toEqual({ label: 'running', active: true })
    for (const s of AGENT_STATES.filter((x) => x !== 'working')) expect(statusPill(s)).toEqual({ label: STATUS_LABEL[s], active: false })
  })
  it('asks only while the process is alive', () => {
    expect(AGENT_STATES.filter(needsCloseConfirm)).toEqual(['starting', 'idle', 'working', 'waiting'])
  })
})

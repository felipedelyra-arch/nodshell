import { describe, expect, it, vi } from 'vitest'
import { AgentError } from '../../src/main/domain/agent'
import { previewCommand, routeCommand, sendCommand, type CommandAgent, type CommandState } from '../../src/main/application/commands'
import { isMicrophoneAllowed } from '../../src/main/security'
import { channels } from '../../src/shared/ipc/channels'

const W = 'w1'
const ag = (id: string, name: string, role: string, extra: Partial<CommandAgent> = {}): CommandAgent => ({ id, name, role, workspaceId: W, state: 'idle', statusUnavailable: false, ...extra })
// squad s1 (Orchestrator o1) with groups Frontend {zoe, leo} and Reviewers {pip}; squad s2 (o2) with Frontend {max}; a loose agent ann and a Team group
const st: CommandState = {
  agents: [ag('o1', 'Orca', 'orchestrator'), ag('zoe', 'Zoe', 'frontend'), ag('leo', 'Leo', 'frontend'), ag('pip', 'Pip', 'reviewer'), ag('o2', 'Olga', 'orchestrator'), ag('max', 'Max', 'frontend'), ag('ann', 'Ann', 'backend'), ag('zz', 'Zoe Two', 'backend'), ag('far', 'Far', 'frontend', { workspaceId: 'other' })],
  groups: [
    { id: 'g1', name: 'Frontend', memberIds: ['zoe', 'leo'] },
    { id: 'g2', name: 'Reviewers', memberIds: ['pip'] },
    { id: 'g3', name: 'Frontend', memberIds: ['max'] },
    { id: 'g4', name: 'Code Team', memberIds: ['ann', 'zz'] },
  ],
  squads: [
    { id: 's1', orchestratorId: 'o1', groupIds: ['g1', 'g2'], extraIds: [] },
    { id: 's2', orchestratorId: 'o2', groupIds: ['g3'], extraIds: [] },
  ],
}
const ids = (r: { targets: { id: string }[] }) => r.targets.map((t) => t.id).sort()
const global = { workspaceId: W }

describe('routeCommand', () => {
  it('routes @name to that agent only, ignoring case, and strips the prefix', () => {
    const r = routeCommand('@zOe  fix the bug', global, st)
    expect(ids(r)).toEqual(['zoe'])
    expect(r.text).toBe('fix the bug')
    expect(r.refused).toEqual([])
  })
  it('takes the longest name that fits (a name that is a prefix of another)', () => {
    expect(ids(routeCommand('@Zoe Two hello', global, st))).toEqual(['zz'])
    expect(routeCommand('@Zoe Two hello', global, st).text).toBe('hello')
    expect(routeCommand('@Zoe Twofold x', global, st).text).toBe('Twofold x') // only "Zoe" fits as a whole word
  })
  it('a group name (with a space) reaches all its members', () => {
    const r = routeCommand('@code team review', global, st)
    expect(ids(r)).toEqual(['ann', 'zz'])
    expect(r.text).toBe('review')
  })
  it('a group name shared by several squads reaches all of them, only inside the workspace', () => {
    expect(ids(routeCommand('@FRONTEND go', global, st))).toEqual(['leo', 'max', 'zoe'])
  })
  it('without @, the global bar goes to every Orchestrator of the workspace, and the text is kept', () => {
    const r = routeCommand('  do it ', global, st)
    expect(ids(r)).toEqual(['o1', 'o2'])
    expect(r.text).toBe('do it')
  })
  it('without any Orchestrator, refuses and hints at @name', () => {
    const r = routeCommand('do it', global, { ...st, squads: [] })
    expect(r.targets).toEqual([])
    expect(r.refused[0]?.reason).toContain('@name: @Orca, @Zoe')
    // a lone agent needs no @; an empty board says what to do
    const lone = routeCommand('do it', global, { agents: [ag('zoe', 'Zoe', 'frontend')], groups: [], squads: [] })
    expect(ids(lone)).toEqual(['zoe'])
    expect(lone.text).toBe('do it')
    expect(routeCommand('do it', global, { agents: [], groups: [], squads: [] }).refused[0]?.reason).toContain('Spawn')
  })
  it('the squad field without @ goes to that Orchestrator only', () => {
    expect(ids(routeCommand('go', { workspaceId: W, squadId: 's2' }, st))).toEqual(['o2'])
  })
  it('the squad field with @ reaches only that squad', () => {
    const sq = { workspaceId: W, squadId: 's1' }
    expect(ids(routeCommand('@Frontend go', sq, st))).toEqual(['leo', 'zoe'])
    expect(ids(routeCommand('@Pip go', sq, st))).toEqual(['pip'])
    const out = routeCommand('@Max go', sq, st) // another squad's agent
    expect(out.targets).toEqual([])
    expect(out.refused[0]?.reason).toContain('Try:')
    expect(out.refused[0]?.reason).not.toContain('Max')
  })
  it('an unknown @ is refused with a short list of the names that exist', () => {
    const r = routeCommand('@Nobody hi', global, st)
    expect(r.targets).toEqual([])
    expect(r.refused[0]?.name).toBe('@Nobody')
    expect(r.refused[0]?.reason).toMatch(/Try: .*Zoe/)
    expect(r.refused[0]?.reason.split(',').length).toBeLessThanOrEqual(9)
  })
  it('a name with nothing after it is refused; a name that only starts a word is not a match', () => {
    expect(routeCommand('@Zoe', global, st).refused[0]?.reason).toContain('Nothing to send')
    expect(ids(routeCommand('@Zoey hi', global, st))).toEqual([])
  })
  it('never reaches another workspace, nor a squad of another workspace', () => {
    expect(ids(routeCommand('@Far hi', global, st))).toEqual([])
    expect(routeCommand('hi', { workspaceId: 'other', squadId: 's1' }, st).refused[0]?.reason).toContain('gone')
    expect(routeCommand('hi', { workspaceId: W, squadId: 'nope' }, st).targets).toEqual([])
  })
})

describe('sendCommand', () => {
  const deps = (state: CommandState, over: { paused?: boolean; submit?: (id: string, t: string) => Promise<void> } = {}) => {
    const sent: [string, string][] = []
    return {
      sent,
      d: {
        state: (o: number) => (o === 1 ? state : { agents: [], groups: [], squads: [] }),
        paused: () => over.paused ?? false,
        submit: async (_o: number, id: string, t: string) => {
          await over.submit?.(id, t)
          sent.push([id, t])
        },
      },
    }
  }
  it('delivers to every target and returns names', async () => {
    const { d, sent } = deps(st)
    const r = await sendCommand(d, 1, global, '@Code Team lint it')
    expect(r.delivered.sort()).toEqual(['Ann', 'Zoe Two'])
    expect(sent.map((s) => s[1])).toEqual(['lint it', 'lint it'])
    expect(r.refused).toEqual([])
  })
  it('another window owns nothing: nobody is reached', async () => {
    const { d, sent } = deps(st)
    const r = await sendCommand(d, 2, global, '@Zoe hi')
    expect(sent).toEqual([])
    expect(r.delivered).toEqual([])
    expect(r.refused).toHaveLength(1)
  })
  it.each([
    ['starting', 'still starting'],
    ['waiting', 'needs you'],
    ['exited', 'not running'],
    ['error', 'not running'],
  ] as const)('refuses an agent that is %s, but still delivers to the others', async (state, why) => {
    const s2: CommandState = { ...st, agents: st.agents.map((a) => (a.id === 'leo' ? { ...a, state } : a)) }
    const { d, sent } = deps(s2)
    const r = await sendCommand(d, 1, { workspaceId: W, squadId: 's1' }, '@Frontend go')
    expect(r.delivered).toEqual(['Zoe'])
    expect(r.refused).toEqual([{ name: 'Leo', reason: expect.stringContaining(why) }])
    expect(sent.map((x) => x[0])).toEqual(['zoe'])
  })
  it('starting is refused even when live status is unavailable; resting and running are delivered', async () => {
    const s2: CommandState = { ...st, agents: st.agents.map((a) => (a.id === 'zoe' ? { ...a, state: 'starting', statusUnavailable: true } : a.id === 'leo' ? { ...a, state: 'working' } : a)) }
    const { d } = deps(s2)
    const r = await sendCommand(d, 1, global, '@Frontend go')
    expect(r.delivered.sort()).toEqual(['Leo', 'Max'])
    expect(r.refused).toEqual([{ name: 'Zoe', reason: 'is still starting' }])
  })
  it('Pause all refuses everyone; a failing delivery is reported with its message only when it is an AgentError', async () => {
    expect((await sendCommand(deps(st, { paused: true }).d, 1, global, '@Zoe x')).refused).toEqual([{ name: 'Zoe', reason: 'is paused' }])
    const bad = deps(st)
    bad.d.submit = async (_o, id) => {
      throw id === 'zoe' ? new AgentError('Agent is not running') : new Error('/secret/path')
    }
    const r = await sendCommand(bad.d, 1, global, '@Frontend x')
    expect(r.refused.find((x) => x.name === 'Zoe')?.reason).toBe('Agent is not running')
    expect(JSON.stringify(r)).not.toContain('secret')
  })
  it('a refused routing (unknown name) reaches no one and never calls submit', async () => {
    const submit = vi.fn()
    const r = await sendCommand({ state: () => st, paused: () => false, submit }, 1, global, '@Nobody x')
    expect(submit).not.toHaveBeenCalled()
    expect(r.delivered).toEqual([])
  })
})

describe('planCommand and previewCommand', () => {
  const only = (ids: string[]): CommandState => ({ ...st, agents: st.agents.filter((a) => ids.includes(a.id) || a.workspaceId !== W), squads: st.squads.filter((s) => ids.includes(s.orchestratorId)) })
  const view = (state: CommandState, paused = false) => ({ state: () => state, paused: () => paused })
  const names = (r: { targets: { name: string }[] }) => r.targets.map((t) => t.name)

  it('@agent and @group give their targets, a group also its name', () => {
    expect(names(previewCommand(view(st), 1, global, '@zoe hi'))).toEqual(['Zoe'])
    expect(previewCommand(view(st), 1, global, '@zoe hi').group).toBeUndefined()
    const g = previewCommand(view(st), 1, { workspaceId: W, squadId: 's1' }, '@Frontend go')
    expect(names(g)).toEqual(['Zoe', 'Leo'])
    expect(g.group).toBe('Frontend')
  })
  it('without @: every Orchestrator, one, or the only agent; with none and several agents it is refused', () => {
    expect(names(previewCommand(view(st), 1, global, 'plan'))).toEqual(['Orchestrator', 'Orchestrator'])
    expect(names(previewCommand(view(only(['o1'])), 1, global, 'plan'))).toEqual(['Orchestrator'])
    expect(names(previewCommand(view(only(['zoe', 'leo'])), 1, global, 'plan'))).toEqual([])
    expect(previewCommand(view(only(['zoe', 'leo'])), 1, global, 'plan').refused[0]?.reason).toContain('@name')
    const lone: CommandState = { agents: [ag('ann', 'Ann', 'backend')], groups: [], squads: [] }
    expect(names(previewCommand(view(lone), 1, global, 'plan'))).toEqual(['Ann'])
  })
  it('an unknown name is refused', () => {
    const p = previewCommand(view(st), 1, global, '@Nobody x')
    expect(p.targets).toEqual([])
    expect(p.refused[0]).toMatchObject({ name: '@Nobody' })
  })
  it('an agent that is starting or waiting is refused; Pause all refuses everyone', () => {
    const s2: CommandState = { ...st, agents: st.agents.map((a) => (a.id === 'leo' ? { ...a, state: 'waiting' } : a.id === 'zoe' ? { ...a, state: 'starting' } : a)) }
    const p = previewCommand(view(s2), 1, { workspaceId: W, squadId: 's1' }, '@Frontend go')
    expect(p.targets).toEqual([])
    expect(p.refused.map((r) => r.name)).toEqual(['Zoe', 'Leo'])
    expect(p.group).toBeUndefined()
    const q = previewCommand(view(st, true), 1, global, '@Zoe x')
    expect(q.targets).toEqual([])
    expect(q.refused).toEqual([{ name: 'Zoe', reason: 'is paused' }])
  })
  it('the preview and the send agree on who is reached, and the preview never submits', async () => {
    const submit = vi.fn(async () => undefined)
    const s2: CommandState = { ...st, agents: st.agents.map((a) => (a.id === 'leo' ? { ...a, state: 'waiting' } : a)) }
    const d = { state: () => s2, paused: () => false, submit }
    const scope = { workspaceId: W, squadId: 's1' }
    const p = previewCommand(d, 1, scope, '@Frontend go')
    expect(submit).not.toHaveBeenCalled()
    const r = await sendCommand(d, 1, scope, '@Frontend go')
    expect(names(p)).toEqual(r.delivered)
    expect(p.refused).toEqual(r.refused)
  })
  it('command:preview shares the send input schema and bounds its answer', () => {
    const id = '3b1b7b7e-2d55-4b7f-9a0e-1c2d3e4f5a6b'
    const c = channels['command:preview']
    expect(c.in.safeParse({ text: 'hi', workspaceId: id }).success).toBe(true)
    expect(c.in.safeParse({ text: 'x'.repeat(20_001), workspaceId: id }).success).toBe(false)
    expect(c.out.safeParse({ targets: Array.from({ length: 41 }, () => ({ name: 'a' })), refused: [] }).success).toBe(false)
  })
})

describe('command and voice schemas', () => {
  const id = '3b1b7b7e-2d55-4b7f-9a0e-1c2d3e4f5a6b'
  it('command:send checks text and ids', () => {
    const c = channels['command:send'].in
    expect(c.safeParse({ text: 'hi', workspaceId: id }).success).toBe(true)
    expect(c.safeParse({ text: 'hi', workspaceId: id, squadId: id }).success).toBe(true)
    expect(c.safeParse({ text: '', workspaceId: id }).success).toBe(false)
    expect(c.safeParse({ text: 'x'.repeat(20_001), workspaceId: id }).success).toBe(false)
    expect(c.safeParse({ text: 'hi', workspaceId: 'x' }).success).toBe(false)
    expect(c.safeParse({ text: 'hi', workspaceId: id, to: 'Zoe' }).success).toBe(true) // unknown keys are dropped, never obeyed
    expect('to' in (c.parse({ text: 'hi', workspaceId: id, to: 'Zoe' }) as object)).toBe(false)
  })
  it('voice:transcribe takes only bounded, even-sized PCM', () => {
    const v = channels['voice:transcribe'].in
    expect(v.safeParse({ pcm: new Uint8Array(32_000) }).success).toBe(true)
    expect(v.safeParse({ pcm: new Uint8Array(0) }).success).toBe(false)
    expect(v.safeParse({ pcm: new Uint8Array(60 * 16_000 * 2 + 2) }).success).toBe(false)
    expect(v.safeParse({ pcm: new Uint8Array(3) }).success).toBe(false)
    expect(v.safeParse({ pcm: 'audio' }).success).toBe(false)
  })
})

describe('microphone permission', () => {
  const o = 'app://app'
  it('only audio, only at the app origin', () => {
    expect(isMicrophoneAllowed('media', ['audio'], 'app://app/index.html', o)).toBe(true)
    expect(isMicrophoneAllowed('media', ['audio', 'video'], 'app://app/index.html', o)).toBe(false)
    expect(isMicrophoneAllowed('media', ['video'], 'app://app/index.html', o)).toBe(false)
    expect(isMicrophoneAllowed('media', undefined, 'app://app/index.html', o)).toBe(false)
    expect(isMicrophoneAllowed('media', ['audio'], 'https://evil.example/', o)).toBe(false)
    expect(isMicrophoneAllowed('geolocation', ['audio'], 'app://app/', o)).toBe(false)
    expect(isMicrophoneAllowed('display-capture', ['audio'], 'app://app/', o)).toBe(false)
  })
})

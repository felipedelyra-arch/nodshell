import { describe, expect, it, vi } from 'vitest'
import { AgentService, type Ports } from '../../src/main/application/agents'
import type { AgentAdapter, HookSignal } from '../../src/main/domain/adapter'
import { HeldInput, type Repo, type Worktree } from '../../src/main/domain/agent'
import { ClaudeAdapter } from '../../src/main/infrastructure/adapters/claude'
import { GenericAdapter } from '../../src/main/infrastructure/adapters/generic'

const repo: Repo = { root: '/r', name: 'r', branch: 'main' }

function setup(spawnFails = false, adapter: AgentAdapter = new GenericAdapter('Shell', '/bin/sh', [], { PATH: '/bin' }), statusTimeoutMs?: number) {
  const writes: string[] = []
  const removed: Worktree[] = []
  let alive = true
  const spawned: { cwd: string; file: string }[] = []
  const hookEvents: ((s: HookSignal) => void)[] = []
  const closedHooks: number[] = []
  const states: string[] = []
  const flags: boolean[] = []
  const ports: Ports = {
    adapter,
    worktrees: {
      add: vi.fn(async (_r: Repo, role: string) => ({ repoRoot: '/r', path: `/wt/${role}-1`, branch: `agent/${role}-1`, base: 'abc' })),
      remove: vi.fn(async (wt: Worktree) => (removed.push(wt), 'removed' as const)),
    },
    ptys: {
      spawnCommand: (_o, _c, _r, c) => {
        if (spawnFails) throw new Error('boom')
        spawned.push({ cwd: c.cwd, file: c.file })
        return '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
      },
      handle: (_o, id) => ({ key: id, write: (d) => void writes.push(d), alive: () => alive }),
      kill: vi.fn(async () => void (alive = false)),
      recentText: () => 'scraped tail',
    },
    hooks: {
      open: vi.fn((_sid: string, onEvent: (s: HookSignal) => void) => {
        hookEvents.push(onEvent)
        return { settingsPath: '/data/s.json', env: {}, close: () => void closedHooks.push(1) }
      }),
    },
    onState: (_o, _id, s, unavailable) => void (states.push(s), flags.push(unavailable)),
  }
  return { svc: new AgentService(ports, statusTimeoutMs), ports, writes, removed, spawned, hookEvents, closedHooks, states, flags }
}

describe('agent short names in the service', () => {
  it('are unique per owner among live agents, concurrent spawns included', async () => {
    const { svc } = setup()
    const all = await Promise.all(Array.from({ length: 12 }, () => svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })))
    expect(new Set(all.map((a) => a.name.toLowerCase())).size).toBe(12)
  })
})

describe('AgentService with a non-Claude adapter', () => {
  it('spawns in the worktree, prompts, and closes with the removal policy', async () => {
    const { svc, writes, removed, spawned, ports, closedHooks } = setup()
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    expect(a).toEqual({ id: '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11', name: expect.stringMatching(/^[A-Z][a-z]{1,4}$/), role: 'qa', branch: 'agent/qa-1', model: 'default', state: 'idle', statusUnavailable: false })
    expect(spawned).toEqual([{ cwd: '/wt/qa-1', file: '/bin/sh' }])
    await svc.submitPrompt(1, a.id, 'hi')
    expect(writes).toEqual(['\x1b[200~hi\x1b[201~', '\r'])
    await expect(svc.submitPrompt(2, a.id, 'x')).rejects.toThrow('Unknown agent')
    await expect(svc.close(2, a.id)).rejects.toThrow('Unknown agent')
    expect(await svc.close(1, a.id)).toBe('removed')
    expect(ports.ptys.kill).toHaveBeenCalledOnce()
    expect(removed).toHaveLength(1)
    await expect(svc.close(1, a.id)).rejects.toThrow('Unknown agent')
    expect(closedHooks).toHaveLength(1)
    expect(svc.size).toBe(0)
  })

  it('requires an open repo and a valid role', async () => {
    const { svc, ports } = setup()
    await expect(svc.spawn(1, null, { role: 'qa', cols: 80, rows: 24 })).rejects.toThrow('Open a repository first')
    await expect(svc.spawn(1, repo, { role: '../x', cols: 80, rows: 24 })).rejects.toThrow('Invalid role')
    expect(ports.worktrees.add).not.toHaveBeenCalled()
  })

  it('rolls the worktree back when the PTY cannot start', async () => {
    const { svc, removed, closedHooks } = setup(true)
    await expect(svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })).rejects.toThrow('boom')
    expect(removed.map((w) => w.branch)).toEqual(['agent/qa-1'])
    expect(closedHooks).toEqual([1]) // the settings file and token go with it
    expect(svc.size).toBe(0)
  })

  it('asks before stopping a live agent, keeps it when refused, and does not ask for one that exited', async () => {
    const { svc, ports, removed } = setup()
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    expect(svc.anyLive()).toBe(true)
    expect(svc.anyLive(1)).toBe(true)
    expect(svc.anyLive(2)).toBe(false)
    const ask = vi.fn(async () => false)
    expect(await svc.close(1, a.id, undefined, ask)).toBe('cancelled')
    expect(ask).toHaveBeenCalledWith({ name: a.name, role: 'qa' })
    expect(ports.ptys.kill).not.toHaveBeenCalled()
    expect(removed).toHaveLength(0)
    expect(svc.size).toBe(1)
    expect(await svc.close(1, a.id, undefined, async () => true)).toBe('removed')
    expect(ports.ptys.kill).toHaveBeenCalledOnce()

    const b = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    svc.signal(b.id, { type: 'exited', code: 0 })
    expect(svc.anyLive()).toBe(false) // nothing left that closing would stop
    const never = vi.fn(async () => false)
    expect(await svc.close(1, b.id, undefined, never)).toBe('removed')
    expect(never).not.toHaveBeenCalled()
  })

  it('closeAll (quit, window gone) stops every agent and keeps its worktree for the saved board', async () => {
    const { svc, ports } = setup()
    await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    await svc.closeAll()
    expect(ports.worktrees.remove).not.toHaveBeenCalled()
    expect(ports.ptys.kill).toHaveBeenCalled()
    expect(svc.size).toBe(0)
  })
})

describe('AgentService with Claude hooks', () => {
  const sid = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
  const hook = (event: string, extra: Partial<HookSignal> = {}): HookSignal => ({ type: 'hook', event, sessionId: sid, ...extra })
  const claude = () => {
    const a = new ClaudeAdapter({ PATH: '/nonexistent' })
    a.buildSpawn = () => ({ cmd: '/bin/claude', args: [], env: {} })
    return a
  }

  it('starts in starting, refuses prompts until ready, then follows hook events and the process exit', async () => {
    const { svc, hookEvents, states, writes } = setup(false, claude())
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    expect(a.state).toBe('starting')
    await expect(svc.submitPrompt(1, a.id, 'hi')).rejects.toThrow('Agent is still starting; answer its terminal first')
    expect(writes).toEqual([])
    const emit = hookEvents[0]!
    emit(hook('SessionStart'))
    emit(hook('SessionStart')) // duplicate: no extra state event
    emit(hook('UserPromptSubmit'))
    emit(hook('Notification', { notificationType: 'permission_prompt' }))
    emit(hook('PostToolUse'))
    emit(hook('Stop'))
    expect(states).toEqual(['idle', 'working', 'waiting', 'working', 'idle'])
    svc.signal(a.id, { type: 'exited', code: 0 })
    emit(hook('Stop')) // late Stop after exit
    expect(states).toEqual(['idle', 'working', 'waiting', 'working', 'idle', 'exited'])
  })

  it('keeps the transcript path of the current session only; falls back to the scrape, labelled as such', async () => {
    const adapter = claude()
    const read = vi.spyOn(adapter, 'readLastMessage').mockResolvedValue(null)
    const { svc, hookEvents } = setup(false, adapter)
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    const emit = hookEvents[0]!
    emit(hook('SessionStart', { transcriptPath: '/p/s.jsonl' }))
    emit(hook('Stop', { sessionId: '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11', transcriptPath: '/p/other.jsonl' }))
    expect(await svc.lastMessage(1, a.id)).toEqual({ text: 'scraped tail', source: 'scrape' })
    expect(read).toHaveBeenLastCalledWith({ sessionId: sid, transcriptPath: '/p/s.jsonl' })
    read.mockResolvedValue('the answer')
    expect(await svc.lastMessage(1, a.id)).toEqual({ text: 'the answer', source: 'transcript' })
    await expect(svc.lastMessage(2, a.id)).rejects.toThrow('Unknown agent')
  })

  it('drops events once the agent is closed', async () => {
    const { svc, hookEvents, states } = setup(false, claude())
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    await svc.close(1, a.id)
    hookEvents[0]!(hook('SessionStart'))
    expect(states).toEqual([])
  })

  describe('when no hook ever arrives (hooks disabled)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    it('stays starting but declares status unavailable after the timeout, and then accepts prompts', async () => {
      const { svc, states, flags, writes } = setup(false, claude(), 30)
      const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
      expect(a.statusUnavailable).toBe(false)
      await expect(svc.submitPrompt(1, a.id, 'hi')).rejects.toThrow('still starting')
      await sleep(60)
      expect(states).toEqual(['starting'])
      expect(flags).toEqual([true])
      await svc.submitPrompt(1, a.id, 'hi')
      expect(writes).toEqual(['\x1b[200~hi\x1b[201~', '\r'])
      await svc.close(1, a.id)
    })
    it('a late SessionStart clears the flag', async () => {
      const { svc, hookEvents, states, flags } = setup(false, claude(), 10)
      await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
      await sleep(30)
      hookEvents[0]!(hook('SessionStart'))
      expect(states).toEqual(['starting', 'idle'])
      expect(flags).toEqual([true, false])
    })
    it('any hook event before the timeout, or a closed agent, means no flag', async () => {
      const heard = setup(false, claude(), 20)
      await heard.svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
      heard.hookEvents[0]!(hook('Notification', { notificationType: 'auth_success' })) // no state change, but hooks work
      const gone = setup(false, claude(), 20)
      const g = await gone.svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
      await gone.svc.close(1, g.id)
      await sleep(50)
      expect(heard.flags).toEqual([])
      expect(gone.flags).toEqual([])
    })
  })
})

describe('AgentService for flows and MCP', () => {
  const sid = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
  const hook = (event: string, extra: Partial<HookSignal> = {}): HookSignal => ({ type: 'hook', event, sessionId: sid, ...extra })
  const claude = () => {
    const a = new ClaudeAdapter({ PATH: '/nonexistent' })
    a.buildSpawn = vi.fn((o) => ({ cmd: '/bin/claude', args: o.mcpConfig ? [`--mcp-config=${o.mcpConfig}`] : [], env: {} }))
    return a
  }

  it('passes each agent its MCP config, whose token names it; closing revokes it; a failed spawn too', async () => {
    const adapter = claude()
    const { svc, ports } = setup(false, adapter)
    const revoked: string[] = []
    let who: (() => string | undefined) | undefined
    ports.mcp = { open: vi.fn((_sid: string, agentId: () => string | undefined) => ((who = agentId), { configPath: '/data/s/mcp.json', close: () => void revoked.push('x') })) }
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24, workspaceId: 'w1' })
    expect(adapter.buildSpawn).toHaveBeenCalledWith(expect.objectContaining({ mcpConfig: '/data/s/mcp.json' }))
    expect(who?.()).toBe(a.id)
    expect(svc.get(1, a.id)?.workspaceId).toBe('w1')
    expect(svc.get(2, a.id)).toBeUndefined()
    expect(svc.byId(a.id)?.ownerId).toBe(1)
    expect(svc.list(1).map((x) => x.id)).toEqual([a.id])
    await svc.close(1, a.id)
    expect(revoked).toHaveLength(1)
    const failing = setup(true, claude())
    const closed: number[] = []
    failing.ports.mcp = { open: () => ({ configPath: '/c', close: () => void closed.push(1) }) }
    await expect(failing.svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })).rejects.toThrow('boom')
    expect(closed).toEqual([1])
  })

  it('inject: only when idle, never while starting (even with status unavailable), working, waiting or after the exit; reports turns ending', async () => {
    const stops: string[] = []
    const idles: string[] = []
    const { svc, hookEvents, writes, ports } = setup(false, claude(), 10)
    ports.onIdle = (_o, id, byStop) => void (byStop ? stops : idles).push(id)
    const submits: string[] = []
    ports.onPromptSubmit = (_o, id) => void submits.push(id)
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    await expect(svc.inject(1, a.id, 'hi')).rejects.toThrow('is still starting')
    await new Promise((r) => setTimeout(r, 30)) // status declared unavailable: the user may prompt, a flow still may not
    await expect(svc.inject(1, a.id, 'hi')).rejects.toThrow('is still starting')
    const emit = hookEvents[0]!
    emit(hook('SessionStart'))
    await svc.inject(1, a.id, 'hi')
    expect(writes).toEqual(['\x1b[200~hi\x1b[201~', '\r'])
    expect(idles).toEqual([a.id]) // ready
    emit(hook('UserPromptSubmit'))
    await expect(svc.inject(1, a.id, 'busy')).rejects.toThrow('is busy')
    emit(hook('Notification', { notificationType: 'permission_prompt' }))
    expect(svc.readiness(1, a.id)).toBe('busy')
    await expect(svc.inject(1, a.id, 'yes')).rejects.toThrow('is busy') // an Enter here would answer the permission dialog
    expect(writes).toHaveLength(2) // only the first, idle one
    emit(hook('PostToolUse'))
    emit(hook('StopFailure')) // a failed turn passes nothing on, but the agent is idle again
    expect(stops).toEqual([])
    expect(idles).toEqual([a.id, a.id])
    emit(hook('UserPromptSubmit'))
    emit(hook('Stop'))
    expect(stops).toEqual([a.id])
    expect(submits).toEqual([a.id, a.id]) // each submitted prompt is reported (main tells the user's from its own injections)
    expect(svc.readiness(1, a.id)).toBe('idle')
    expect(svc.readiness(2, a.id)).toEqual({ refused: 'is not running' })
    svc.setReport(1, a.id, 'halfway')
    expect(svc.get(1, a.id)?.report).toBe('halfway')
    expect(() => svc.setReport(2, a.id, 'x')).toThrow('Unknown agent')
    svc.signal(a.id, { type: 'exited', code: 0 })
    emit(hook('Stop')) // late
    expect(stops).toEqual([a.id])
    await expect(svc.inject(1, a.id, 'hi')).rejects.toThrow('is not running')
    await expect(svc.inject(2, a.id, 'hi')).rejects.toThrow('Unknown agent')
  })
})

describe('prompts never land on a permission dialog', () => {
  const pasted = () => new Promise((r) => setTimeout(r, 30)) // the paste is written; the Enter comes after ENTER_DELAY_MS
  const sid = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
  const hook = (event: string, extra: Partial<HookSignal> = {}): HookSignal => ({ type: 'hook', event, sessionId: sid, ...extra })
  const claude = () => {
    const a = new ClaudeAdapter({ PATH: '/nonexistent' })
    a.buildSpawn = () => ({ cmd: '/bin/claude', args: [], env: {} })
    return a
  }

  it('the user may prompt a working agent but not one that needs them', async () => {
    const { svc, hookEvents, writes } = setup(false, claude())
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    const emit = hookEvents[0]!
    emit(hook('SessionStart'))
    emit(hook('UserPromptSubmit'))
    await svc.submitPrompt(1, a.id, 'also this') // working: the CLI queues it
    expect(writes).toEqual(['\x1b[200~also this\x1b[201~', '\r'])
    emit(hook('Notification', { notificationType: 'permission_prompt' }))
    await expect(svc.submitPrompt(1, a.id, 'x')).rejects.toThrow('Answer in the terminal first')
    expect(writes).toHaveLength(2)
  })

  it('a dialog opening between the paste and the Enter withholds the Enter (user prompt and injection alike)', async () => {
    const { svc, hookEvents, writes } = setup(false, claude())
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    const emit = hookEvents[0]!
    emit(hook('SessionStart'))
    emit(hook('UserPromptSubmit'))
    const user = svc.submitPrompt(1, a.id, 'user text')
    await pasted()
    emit(hook('Notification', { notificationType: 'permission_prompt' })) // during the paste delay
    await expect(user).rejects.toThrow('Answer in the terminal first, the text was left unsent in its input')
    expect(writes).toEqual(['\x1b[200~user text\x1b[201~'])
    emit(hook('PostToolUse'))
    emit(hook('Stop'))
    writes.length = 0
    const flow = svc.inject(1, a.id, 'flow text')
    await pasted()
    emit(hook('UserPromptSubmit')) // the user started a turn meanwhile
    await expect(flow).rejects.toBeInstanceOf(HeldInput)
    expect(writes).toEqual(['\x1b[200~flow text\x1b[201~'])
  })

  it('Pause all is checked inside the queue: a prompt waiting behind another, or its Enter, never reaches a stopped process', async () => {
    const { svc, hookEvents, writes } = setup(false, claude())
    const a = await svc.spawn(1, repo, { role: 'qa', cols: 80, rows: 24 })
    hookEvents[0]!(hook('SessionStart'))
    let paused = false
    const guard = () => (paused ? 'is paused' : null)
    const first = svc.inject(1, a.id, 'one', guard).catch((e: Error) => e.message)
    const second = svc.inject(1, a.id, 'two', guard).catch((e: Error) => e.message) // waits behind the first in the PTY's queue
    await pasted()
    paused = true // Pause all between the first paste and its Enter
    expect(await first).toBe('is paused, the text was left unsent in its input')
    expect(await second).toBe('is paused')
    expect(writes).toEqual(['\x1b[200~one\x1b[201~'])
  })
})

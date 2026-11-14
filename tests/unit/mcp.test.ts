import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { callTool, toolList, TOOL_TEXT_MAX, type Peer, type ToolDeps } from '../../src/main/application/mcpTools'
import { AgentError } from '../../src/main/domain/agent'
import { McpService, mcpConfig } from '../../src/main/infrastructure/mcp/config'
import { MCP_MAX_LINE, McpServer } from '../../src/main/infrastructure/mcp/server'

const RELAY_SRC = resolve('src/main/infrastructure/mcp/relay.ts')
const sid = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
let tmp: string
beforeAll(() => (tmp = mkdtempSync(join(tmpdir(), 'mcp-test-'))))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const rpc = (id: number | undefined, method: string, params?: unknown) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) })
const line = (token: unknown, message: unknown) => JSON.stringify({ token, message })

describe('McpServer (JSON-RPC over the private socket)', () => {
  let server: McpServer
  const calls: { agentId: string; name: string; args: unknown }[] = []
  let alive = true
  let token: string
  beforeAll(async () => {
    server = await McpServer.start(join(tmp, 'mcp.sock'), { list: () => toolList(), call: async (agentId, name, args) => (calls.push({ agentId, name, args }), { text: `ran ${name}`, isError: false }) })
    token = server.register(() => (alive ? 'agent-1' : undefined)).token
  })
  afterAll(() => server.close())

  it('socket 0600', () => {
    expect(statSync(server.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(server.socketPath).isSocket()).toBe(true)
  })

  it.each([
    ['no token', () => JSON.stringify({ message: rpc(1, 'tools/list') })],
    ['a wrong token', () => line('0'.repeat(64), rpc(1, 'tools/list'))],
    ['a malformed token', () => line('xyz', rpc(1, 'tools/list'))],
    ['a bare JSON-RPC message', () => JSON.stringify(rpc(1, 'tools/list'))],
  ])('rejects %s without running anything', async (_n, l) => {
    const n = calls.length
    expect(await server.handleLine(l())).toMatchObject({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } })
    expect(await server.handleLine(l().replace('tools/list', 'tools/call'))).toMatchObject({ error: { code: -32001 } })
    expect(calls).toHaveLength(n)
  })

  it('rejects a revoked token, and one whose agent is gone', async () => {
    const r = server.register(() => 'agent-2')
    expect(await server.handleLine(line(r.token, rpc(1, 'ping')))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    r.close()
    expect(await server.handleLine(line(r.token, rpc(2, 'ping')))).toMatchObject({ id: 2, error: { code: -32001 } })
    alive = false
    expect(await server.handleLine(line(token, rpc(3, 'tools/call', { name: 'list_agents', arguments: {} })))).toMatchObject({ error: { code: -32001 } })
    alive = true
    expect(calls).toEqual([])
  })

  it('initialize, notifications, tools/list and tools/call; unknown methods and bad input are errors', async () => {
    const init = await server.handleLine(line(token, rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude', version: '2' } })))
    expect(init).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-canvas', version: '1.0.0' } } })
    expect(await server.handleLine(line(token, rpc(undefined, 'notifications/initialized')))).toBeNull()
    const list = (await server.handleLine(line(token, rpc(2, 'tools/list')))) as { result: { tools: { name: string; inputSchema: { type: string } }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['list_agents', 'send_message', 'read_last_message', 'report_status', 'memory_read', 'memory_write'])
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object')
    expect(await server.handleLine(line(token, rpc(3, 'tools/call', { name: 'send_message', arguments: { to: 'Leo', text: 'hi' } })))).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'ran send_message' }], isError: false } })
    expect(calls).toEqual([{ agentId: 'agent-1', name: 'send_message', args: { to: 'Leo', text: 'hi' } }])
    expect(await server.handleLine(line(token, rpc(4, 'resources/list')))).toMatchObject({ id: 4, error: { code: -32601 } })
    expect(await server.handleLine(line(token, rpc(5, 'tools/call', { name: 7 })))).toMatchObject({ id: 5, error: { code: -32602 } })
    expect(await server.handleLine(line(token, { id: 6, method: 'ping' }))).toMatchObject({ id: 6, error: { code: -32600 } })
    expect(await server.handleLine('{nope')).toMatchObject({ id: null, error: { code: -32700 } })
  })

  it('rate-limits a flood from one agent', async () => {
    const r = server.register(() => 'agent-3')
    const replies = await Promise.all(Array.from({ length: 40 }, (_, i) => server.handleLine(line(r.token, rpc(i, 'ping')))))
    expect(replies.filter((x) => x && 'error' in x && x.error?.code === -32002).length).toBeGreaterThanOrEqual(20)
    r.close()
  })

  it('over the socket: one reply per request, in order; an oversized line closes the connection', async () => {
    const talk = (data: string, expect: number) =>
      new Promise<{ lines: string[]; closed: boolean }>((done) => {
        const s = connect(server.socketPath)
        let buf = ''
        const finish = (closed: boolean) => done({ lines: buf.split('\n').filter(Boolean), closed })
        s.on('data', (c) => {
          buf += c.toString()
          if (buf.split('\n').filter(Boolean).length < expect) return
          s.destroy()
          finish(false)
        })
        s.on('close', () => finish(true))
        s.on('error', () => undefined)
        s.write(data)
      })
    const ok = await talk(`${line(token, rpc(1, 'ping'))}\n${line(token, rpc(2, 'tools/list'))}\n`, 2)
    expect(ok.lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2])
    const big = await talk(`${line(token, { ...rpc(9, 'ping'), pad: 'x'.repeat(MCP_MAX_LINE) })}\n`, 1)
    expect(big).toEqual({ lines: [], closed: true })
  })
})

describe('MCP tools', () => {
  const peers: Peer[] = [
    { id: 'zoe', ownerId: 1, workspaceId: 'w1', name: 'Zoe', role: 'frontend', state: 'idle' },
    { id: 'pip', ownerId: 1, workspaceId: 'w1', name: 'Pip', role: 'frontend', state: 'working' },
    { id: 'leo', ownerId: 1, workspaceId: 'w1', name: 'Leo', role: 'reviewer', state: 'starting' },
    { id: 'max', ownerId: 1, workspaceId: 'w1', name: 'Max', role: 'orchestrator', state: 'idle' },
    { id: 'kai', ownerId: 1, workspaceId: 'w1', name: 'Kai', role: 'frontend', state: 'idle' }, // another squad's frontend
    { id: 'ada', ownerId: 1, workspaceId: 'w2', name: 'Ada', role: 'backend', state: 'idle' },
    { id: 'bo', ownerId: 2, workspaceId: 'w1', name: 'Bo', role: 'backend', state: 'idle' },
  ]
  const groups = [
    { id: 'gf', name: 'Frontend', memberIds: ['zoe', 'pip'] },
    { id: 'gf2', name: 'Frontend', memberIds: ['kai'] },
    { id: 'gr', name: 'Reviewers', memberIds: ['leo'] },
    { id: 'gb', name: 'Backend', memberIds: ['ada'] },
  ]
  function deps(over: Partial<ToolDeps> = {}) {
    const send = vi.fn<ToolDeps['flow']['send']>(async (_o, _from, targets) => ({ sent: targets.map((t) => t.name), queued: [], skipped: [] }))
    const report = vi.fn()
    const create = vi.fn((_o: number, squadId: string, _text: string, assignee: { name: string }) => ({ id: `t-${assignee.name}`, squadId }) as unknown as ReturnType<ToolDeps['tasks']['create']>)
    const settle = vi.fn()
    const spawn = vi.fn(async (me: Peer) => `Started Uma for ${me.name}`)
    const d: ToolDeps = {
      agent: (id) => peers.find((p) => p.id === id),
      agents: (o) => peers.filter((p) => p.ownerId === o),
      groups: (o) => (o === 1 ? groups : []),
      squads: (o) => (o === 1 ? [{ id: 'q1', orchestratorId: 'max', groupIds: ['gf', 'gr'] }] : []),
      groupOf: (id) => groups.find((g) => g.memberIds.includes(id)),
      lastMessage: async (_o, id) => (id === 'pip' ? 'the last reply' : null),
      report,
      paused: () => false,
      flow: { send, flowsPaused: () => false },
      tasks: { create, settle },
      spawn,
      memory: { read: () => '', write: () => undefined },
      ...over,
    }
    return { d, send, report, create, settle, spawn }
  }
  const text = (r: { text: string }) => r.text

  it('refuses unknown tools, invalid arguments and a closed caller', async () => {
    const { d, send } = deps()
    expect(await callTool(d, 'zoe', 'spawn_agent', { preset: 'Backend', task: 'x' })).toEqual({ text: 'Only an Orchestrator can use spawn_agent', isError: true })
    expect(await callTool(d, 'zoe', 'memory_read', {})).toEqual({ text: 'Invalid arguments', isError: true })
    for (const args of [{}, { to: 'Leo' }, { to: 'Leo', text: '' }, { to: 'Leo', text: '   ' }, { to: 'Le\u0007o', text: 'x' }, { to: 'x'.repeat(41), text: 'x' }, { to: 'Leo', text: 'x'.repeat(10_001) }, 'nope'])
      expect(await callTool(d, 'zoe', 'send_message', args)).toEqual({ text: 'Invalid arguments', isError: true })
    expect(await callTool(d, 'zoe', 'read_last_message', { agent: '../etc' })).toEqual({ text: 'Invalid arguments', isError: true })
    expect(await callTool(d, 'gone', 'list_agents', {})).toEqual({ text: 'This agent is closed', isError: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('list_agents: only the caller\'s window and workspace, with group and state; paused while Pause all holds', async () => {
    const { d } = deps()
    const list = JSON.parse(text(await callTool(d, 'zoe', 'list_agents', {}))) as { name: string; group: string | null; state: string; you?: boolean }[]
    expect(list.map((a) => a.name)).toEqual(['Zoe', 'Pip', 'Leo', 'Max', 'Kai'])
    expect(list[0]).toEqual({ name: 'Zoe', role: 'frontend', group: 'Frontend', state: 'resting', you: true })
    expect(list.map((a) => a.state)).toEqual(['resting', 'running', 'starting', 'resting', 'resting'])
    expect(list[3]!.group).toBeNull()
    const paused = JSON.parse(text(await callTool(deps({ paused: () => true }).d, 'zoe', 'list_agents', {}))) as { state: string }[]
    expect(paused.every((a) => a.state === 'paused')).toBe(true)
  })

  it('send_message: to an agent by name, to a group (never back to the caller), never outside the workspace or window', async () => {
    const { d, send } = deps()
    expect(await callTool(d, 'zoe', 'send_message', { to: 'leo', text: 'please review' })).toEqual({ text: 'Sent to Leo', isError: false })
    expect(send).toHaveBeenLastCalledWith(1, 'zoe', [peers[2]], 'From Zoe (frontend):\nplease review', undefined)
    expect(await callTool(d, 'zoe', 'send_message', { to: 'Frontend', text: 'sync' })).toEqual({ text: 'Sent to Pip', isError: false }) // its own squad's group, without itself
    expect(await callTool(d, 'max', 'send_message', { to: 'FRONTEND', text: 'go' })).toEqual({ text: 'Sent to Zoe, Pip', isError: false }) // two groups share the name: the caller's squad wins
    expect(await callTool(d, 'leo', 'send_message', { to: 'Frontend', text: 'go' })).toEqual({ text: 'Sent to Zoe, Pip', isError: false })
    expect(await callTool(d, 'kai', 'send_message', { to: 'Frontend', text: 'go' })).toMatchObject({ isError: true, text: 'Several groups are named Frontend, message an agent by name' })
    expect(await callTool(d, 'zoe', 'send_message', { to: 'Zoe', text: 'me' })).toEqual({ text: 'An agent cannot message itself', isError: true })
    expect(await callTool(d, 'kai', 'send_message', { to: 'Frontend', text: 'x' })).toMatchObject({ isError: true })
    expect(await callTool(d, 'zoe', 'send_message', { to: 'Ada', text: 'x' })).toEqual({ text: 'No agent or group named Ada in this workspace', isError: true }) // another workspace
    expect(await callTool(d, 'zoe', 'send_message', { to: 'Backend', text: 'x' })).toMatchObject({ isError: true }) // a group of another workspace
    expect(await callTool(d, 'zoe', 'send_message', { to: 'Bo', text: 'x' })).toMatchObject({ isError: true }) // another window
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('send_message: refused while paused, when nobody could take it, or when a guard refuses', async () => {
    expect(await callTool(deps({ paused: () => true }).d, 'zoe', 'send_message', { to: 'Leo', text: 'x' })).toEqual({ text: 'Everything is paused', isError: true })
    const none = deps({ flow: { flowsPaused: () => false, send: async () => ({ sent: [], queued: [], skipped: ['Leo is still starting'] }) } })
    expect(await callTool(none.d, 'zoe', 'send_message', { to: 'Leo', text: 'x' })).toEqual({ text: 'Not delivered, Leo is still starting', isError: true })
    const some = deps({ flow: { flowsPaused: () => false, send: async () => ({ sent: ['Zoe'], queued: [], skipped: ['Pip is paused'] }) } })
    expect(await callTool(some.d, 'max', 'send_message', { to: 'Frontend', text: 'x' })).toEqual({ text: 'Sent to Zoe. Not delivered, Pip is paused', isError: false })
    const later = deps({ flow: { flowsPaused: () => false, send: async () => ({ sent: [], queued: ['Zoe', 'Pip'], skipped: [] }) } })
    expect(await callTool(later.d, 'max', 'send_message', { to: 'Frontend', text: 'x' })).toEqual({ text: 'Queued for Zoe, Pip, delivered when their turn ends', isError: false })
    const guard = deps({ flow: { flowsPaused: () => false, send: async () => Promise.reject(new AgentError('Too many messages, all flows paused')) } })
    expect(await callTool(guard.d, 'zoe', 'send_message', { to: 'Leo', text: 'x' })).toEqual({ text: 'Too many messages, all flows paused', isError: true })
  })

  it('read_last_message and report_status', async () => {
    const { d, report } = deps({ lastMessage: async (_o, id) => (id === 'pip' ? 'y'.repeat(TOOL_TEXT_MAX + 5) : null) })
    expect(text(await callTool(d, 'zoe', 'read_last_message', { agent: 'Pip' }))).toHaveLength(TOOL_TEXT_MAX)
    expect(await callTool(d, 'zoe', 'read_last_message', { agent: 'Leo' })).toEqual({ text: 'Leo has no message yet', isError: false })
    expect(await callTool(d, 'zoe', 'read_last_message', { agent: 'Ada' })).toMatchObject({ isError: true })
    expect(await callTool(d, 'zoe', 'report_status', { text: '  half\u001b[31m done\n ' })).toEqual({ text: 'Status reported', isError: false })
    expect(report).toHaveBeenCalledWith(1, 'zoe', 'half[31m done')
    // line and paragraph separators, NEL, zero-width and bidi characters never reach the user
    expect(await callTool(d, 'zoe', 'report_status', { text: 'a\u2028b\u2029c\u0085d\u200be\ufeff\u202ef\u00adg' })).toEqual({ text: 'Status reported', isError: false })
    expect(report).toHaveBeenLastCalledWith(1, 'zoe', 'a b c defg')
    expect(await callTool(d, 'zoe', 'report_status', { text: '\u200b\u2028\ufeff' })).toEqual({ text: 'Invalid arguments', isError: true })
    expect(await callTool(d, 'zoe', 'report_status', { text: 'x'.repeat(201) })).toMatchObject({ isError: true })
  })
})

describe('MCP tools for an Orchestrator', () => {
  const peers: Peer[] = [
    { id: 'max', ownerId: 1, workspaceId: 'w1', name: 'Max', role: 'orchestrator', state: 'idle' },
    { id: 'zoe', ownerId: 1, workspaceId: 'w1', name: 'Zoe', role: 'frontend', state: 'idle' },
    { id: 'pip', ownerId: 1, workspaceId: 'w1', name: 'Pip', role: 'frontend', state: 'idle' },
    { id: 'leo', ownerId: 1, workspaceId: 'w1', name: 'Leo', role: 'reviewer', state: 'idle' },
    { id: 'kai', ownerId: 1, workspaceId: 'w1', name: 'Kai', role: 'backend', state: 'idle' }, // loose, not in the squad
    { id: 'sol', ownerId: 1, workspaceId: 'w1', name: 'Sol', role: 'orchestrator', state: 'idle' }, // an Orchestrator without a squad
  ]
  const groups = [
    { id: 'gf', name: 'Frontend', memberIds: ['zoe', 'pip'] },
    { id: 'gr', name: 'Reviewers', memberIds: ['leo'] },
  ]
  function deps() {
    const send = vi.fn<ToolDeps['flow']['send']>(async (_o, _from, targets) => ({ sent: targets.map((t) => t.name), queued: [], skipped: [] }))
    const create = vi.fn((_o: number, squadId: string) => ({ id: `t${create.mock.calls.length}`, squadId }) as unknown as ReturnType<ToolDeps['tasks']['create']>)
    const settle = vi.fn()
    const spawn = vi.fn(async (me: Peer, input: { preset: string }) => `Started Uma (${input.preset}) for ${me.name}`)
    const d: ToolDeps = {
      agent: (id) => peers.find((p) => p.id === id),
      agents: () => peers,
      groups: () => groups,
      squads: () => [{ id: 'q1', orchestratorId: 'max', groupIds: ['gf', 'gr'] }],
      groupOf: (id) => groups.find((g) => g.memberIds.includes(id)),
      lastMessage: async () => null,
      report: () => undefined,
      paused: () => false,
      flow: { send, flowsPaused: () => false },
      tasks: { create, settle },
      spawn,
      memory: { read: () => '', write: () => undefined },
    }
    return { d, send, create, settle, spawn }
  }

  it('lists spawn_agent only for an Orchestrator', () => {
    expect(toolList().map((t) => t.name)).toEqual(['list_agents', 'send_message', 'read_last_message', 'report_status', 'memory_read', 'memory_write'])
    const all = toolList(true)
    expect(all.map((t) => t.name)).toEqual(['list_agents', 'send_message', 'read_last_message', 'report_status', 'spawn_agent', 'memory_read', 'memory_write'])
    expect(all[4]!.inputSchema).toMatchObject({ type: 'object', required: ['preset', 'task'], properties: { model: { enum: ['opus', 'sonnet', 'haiku'] } } })
  })

  it('send_message from the Orchestrator to its own squad creates a task (agent or group), titled by the message; settled after the send', async () => {
    const { d, send, create, settle } = deps()
    expect(await callTool(d, 'max', 'send_message', { to: 'frontend', text: 'Build the login page\nwith a form' })).toEqual({ text: 'Sent to Zoe, Pip', isError: false })
    expect(create).toHaveBeenLastCalledWith(1, 'q1', 'Build the login page\nwith a form', { kind: 'group', id: 'gf', name: 'Frontend' }, ['zoe', 'pip'])
    expect(send).toHaveBeenLastCalledWith(1, 'max', [peers[1], peers[2]], 'From Max (orchestrator):\nBuild the login page\nwith a form', 't1')
    expect(settle).toHaveBeenLastCalledWith('t1')
    await callTool(d, 'max', 'send_message', { to: 'Leo', text: 'review it' })
    expect(create).toHaveBeenLastCalledWith(1, 'q1', 'review it', { kind: 'agent', id: 'leo', name: 'Leo' }, ['leo'])
    expect(send.mock.lastCall![4]).toBe('t2')
  })

  it('with flows paused by a guard, send_message is refused before any task exists', async () => {
    const { d, send, create } = deps()
    d.flow.flowsPaused = () => true
    expect(await callTool(d, 'max', 'send_message', { to: 'Leo', text: 'x' })).toEqual({ text: 'Flows are paused', isError: true })
    expect(create).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('creates no task for a message outside the squad, or from anyone but its Orchestrator; a refused send still settles its task', async () => {
    const { d, send, create, settle } = deps()
    await callTool(d, 'max', 'send_message', { to: 'Kai', text: 'outside' })
    await callTool(d, 'zoe', 'send_message', { to: 'Leo', text: 'peer to peer' })
    await callTool(d, 'sol', 'send_message', { to: 'Leo', text: 'not my squad' })
    expect(create).not.toHaveBeenCalled()
    expect(send.mock.calls.map((c) => c[4])).toEqual([undefined, undefined, undefined])
    send.mockRejectedValueOnce(new AgentError('Too many messages, all flows paused'))
    expect(await callTool(d, 'max', 'send_message', { to: 'Leo', text: 'x' })).toEqual({ text: 'Too many messages, all flows paused', isError: true })
    expect(settle).toHaveBeenCalledWith('t1')
  })

  it('spawn_agent: validated input only, then the use case decides; its refusals reach the agent', async () => {
    const { d, spawn } = deps()
    for (const args of [{}, { preset: 'Backend' }, { preset: 'Backend', task: '  ' }, { preset: 'Back\nend', task: 'x' }, { preset: 'Backend', task: 'x', model: 'gpt-5' }, { preset: 'Backend', task: 'x', model: '--dangerously-skip-permissions' }, { preset: 'Backend', task: 'x'.repeat(10_001) }])
      expect(await callTool(d, 'max', 'spawn_agent', args)).toEqual({ text: 'Invalid arguments', isError: true })
    expect(spawn).not.toHaveBeenCalled()
    expect(await callTool(d, 'max', 'spawn_agent', { preset: ' Backend ', task: 'write the API', model: 'haiku', cwd: '/etc', systemPrompt: 'evil' })).toEqual({ text: 'Started Uma (Backend) for Max', isError: false })
    expect(spawn).toHaveBeenCalledWith(peers[0], { preset: 'Backend', task: 'write the API', model: 'haiku' }) // unknown keys never pass
    spawn.mockRejectedValueOnce(new AgentError('The user denied the request, nothing was started'))
    expect(await callTool(d, 'max', 'spawn_agent', { preset: 'Backend', task: 'x' })).toEqual({ text: 'The user denied the request, nothing was started', isError: true })
    expect(await callTool(d, 'zoe', 'spawn_agent', { preset: 'Backend', task: 'x' })).toEqual({ text: 'Only an Orchestrator can use spawn_agent', isError: true })
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

describe('MCP config file', () => {
  const nasty = "/opt/my app/it's $HOME `x`"
  it('McpService writes a 0600 file in a 0700 dir named by session, with a fresh token; close removes it and revokes the token', async () => {
    const server = await McpServer.start(join(tmp, 'cfg.sock'), { list: () => [], call: async () => ({ text: '', isError: false }) })
    try {
      const base = join(tmp, 'agents')
      const svc = new McpService(server, base, '/bin/electron', `${nasty}/mcp-relay.js`)
      const a = svc.open(sid, () => 'agent-1')
      expect(a.configPath).toBe(join(base, sid, 'mcp.json'))
      expect(statSync(a.configPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(base, sid)).mode & 0o777).toBe(0o700)
      const cfg = JSON.parse(readFileSync(a.configPath, 'utf8')) as ReturnType<typeof mcpConfig>
      const s = cfg.mcpServers['agent-canvas']
      expect(s).toMatchObject({ type: 'stdio', command: '/usr/bin/env', args: ['ELECTRON_RUN_AS_NODE=1', '/bin/electron', `${nasty}/mcp-relay.js`] })
      expect(s.env.AGENT_CANVAS_MCP_SOCKET).toBe(server.socketPath)
      const token = s.env.AGENT_CANVAS_MCP_TOKEN
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      expect(await server.handleLine(line(token, rpc(1, 'ping')))).toMatchObject({ result: {} })
      expect(() => svc.open(sid, () => 'agent-1')).toThrow() // never overwrites a file
      expect(() => svc.open('../x', () => 'x')).toThrow('Invalid session id')
      a.close()
      expect(existsSync(a.configPath)).toBe(false)
      expect(await server.handleLine(line(token, rpc(2, 'ping')))).toMatchObject({ error: { code: -32001 } })
    } finally {
      server.close()
    }
    expect(() => new McpService(null, tmp, '/e', '/r').open(sid, () => 'x')).toThrow('Agent messaging is unavailable')
    expect(() => mcpConfig('/e', 'relative.js', '/s', 't')).toThrow()
  })
})

describe('MCP relay (child process, as Claude Code runs it)', () => {
  let relay: string
  beforeAll(() => {
    const dir = join(tmp, "relay dir it's $HOME")
    mkdirSync(dir)
    relay = join(dir, 'mcp-relay.ts')
    copyFileSync(RELAY_SRC, relay)
  })
  /** Runs the relay with `env`, writes `input` to its stdin and waits for `replies` stdout lines (or its exit). */
  const run = (env: Record<string, string>, input: string, replies: number) =>
    new Promise<{ out: string[]; err: string; code: number | null }>((done) => {
      const p = spawn('/usr/bin/env', ['ELECTRON_RUN_AS_NODE=1', process.execPath, relay], { env: { PATH: process.env['PATH'] ?? '', ...env } })
      let out = ''
      let err = ''
      const finish = (code: number | null) => done({ out: out.split('\n').filter(Boolean), err: err.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, ''), code })
      p.stdout.on('data', (c) => {
        out += c
        if (out.split('\n').filter(Boolean).length >= replies) p.stdin.end()
      })
      p.stderr.on('data', (c) => (err += c))
      p.on('exit', finish)
      p.stdin.write(input)
      if (replies === 0) p.stdin.end()
    })

  it('forwards each line with the token and writes each reply back, nothing on stderr', async () => {
    const server = await McpServer.start(join(tmp, 'relay.sock'), { list: () => toolList(), call: async (_a, name) => ({ text: `ran ${name}`, isError: false }) })
    const { token } = server.register(() => 'agent-1')
    try {
      const input = [rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), rpc(undefined, 'notifications/initialized'), rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'list_agents', arguments: {} })].map((m) => JSON.stringify(m)).join('\n') + '\n' + 'x'.repeat(MCP_MAX_LINE + 10) + '\nnot json\n'
      const r = await run({ AGENT_CANVAS_MCP_SOCKET: server.socketPath, AGENT_CANVAS_MCP_TOKEN: token }, input, 4)
      const replies = r.out.map((l) => JSON.parse(l) as { id: number | null; result?: { content?: unknown }; error?: unknown })
      expect(replies.map((x) => x.id).sort()).toEqual([1, 2, 3, null, null].sort()) // the parse error and the oversized line without an id
      expect(replies.find((x) => x.id === 3)!.result).toEqual({ content: [{ type: 'text', text: 'ran list_agents' }], isError: false })
      expect(r.err).toBe('')
      const denied = await run({ AGENT_CANVAS_MCP_SOCKET: server.socketPath, AGENT_CANVAS_MCP_TOKEN: 'f'.repeat(64) }, JSON.stringify(rpc(1, 'tools/list')) + '\n', 1)
      expect(JSON.parse(denied.out[0]!)).toMatchObject({ id: 1, error: { code: -32001 } })
    } finally {
      server.close()
    }
  })

  it('a request just under its limit reaches the app without closing the connection; a larger one gets an error for its id, and the next still works', async () => {
    const server = await McpServer.start(join(tmp, 'big.sock'), { list: () => toolList(), call: async (_a, name) => ({ text: `ran ${name}`, isError: false }) })
    const { token } = server.register(() => 'agent-1')
    try {
      const sized = (id: number, size: number) => {
        const base = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'report_status', arguments: { text: '' } }, id })
        return base.replace('"text":""', `"text":"${'x'.repeat(size - base.length)}"`)
      }
      const near = sized(7, MCP_MAX_LINE - 256 - 4)
      const over = sized(8, MCP_MAX_LINE)
      const after = JSON.stringify(rpc(9, 'ping'))
      const r = await run({ AGENT_CANVAS_MCP_SOCKET: server.socketPath, AGENT_CANVAS_MCP_TOKEN: token }, `${near}\n${over}\n${after}\n`, 3)
      const byId = new Map(r.out.map((l) => JSON.parse(l) as { id: number; result?: unknown; error?: { code: number; message: string } }).map((x) => [x.id, x]))
      expect(byId.get(7)!.result).toEqual({ content: [{ type: 'text', text: 'ran report_status' }], isError: false })
      expect(byId.get(8)!.error).toEqual({ code: -32600, message: 'Request too large' })
      expect(byId.get(9)!.result).toEqual({})
      expect(r.err).toBe('')
    } finally {
      server.close()
    }
  })

  it('exits quietly without its environment or when the app is not there', async () => {
    expect(await run({}, '', 0)).toMatchObject({ out: [], err: '', code: 1 })
    expect(await run({ AGENT_CANVAS_MCP_SOCKET: join(tmp, 'none.sock'), AGENT_CANVAS_MCP_TOKEN: 'a'.repeat(64) }, '', 0)).toMatchObject({ out: [], err: '', code: 1 })
  })
})

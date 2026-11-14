import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentError } from '../../domain/agent'
import { checkPath, UUID_RE } from '../hooks/settings'
import type { McpServer } from './server'

/**
 * Claude Code MCP config with the app's stdio server: the relay run through `/usr/bin/env` (exec form, argv only, no shell),
 * with the socket and the agent's token in its own environment. ELECTRON_RUN_AS_NODE reaches the relay only.
 */
export function mcpConfig(execPath: string, relayPath: string, socketPath: string, token: string) {
  return {
    mcpServers: {
      'agent-canvas': {
        type: 'stdio',
        command: '/usr/bin/env',
        args: ['ELECTRON_RUN_AS_NODE=1', checkPath(execPath), checkPath(relayPath)],
        env: { AGENT_CANVAS_MCP_SOCKET: checkPath(socketPath), AGENT_CANVAS_MCP_TOKEN: token },
      },
    },
  }
}

/**
 * Per agent: a token on the MCP server plus `<baseDir>/<sessionId>/mcp.json` (dir 0700, file 0600), next to its hook settings and
 * outside any worktree. `close()` revokes the token and removes the file; stale ones go with the settings dirs at startup.
 */
export class McpService {
  constructor(
    private server: McpServer | null,
    private baseDir: string,
    private execPath: string,
    private relayPath: string,
  ) {}

  open(sessionId: string, agentId: () => string | undefined): { configPath: string; close(): void } {
    if (!this.server) throw new AgentError('Agent messaging is unavailable')
    if (!UUID_RE.test(sessionId)) throw new AgentError('Invalid session id')
    const dir = join(this.baseDir, sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const configPath = join(dir, 'mcp.json')
    const reg = this.server.register(agentId)
    try {
      writeFileSync(configPath, JSON.stringify(mcpConfig(this.execPath, this.relayPath, this.server.socketPath, reg.token), null, 2), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      reg.close()
      throw e
    }
    return {
      configPath,
      close: () => {
        reg.close()
        rmSync(configPath, { force: true })
      },
    }
  }
}

import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { HookSignal } from '../../domain/adapter'
import { AgentError } from '../../domain/agent'
import type { HookListener } from './listener'
import { HOOK_EVENTS } from './schema'

/** Seconds; the relay gives up after 2 s on its own. */
const HOOK_TIMEOUT_S = 5
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function checkPath(p: string): string {
  // `${...}` would be substituted by Claude Code (path placeholders) even in exec form
  if (!isAbsolute(p) || p.includes('\0') || p.includes('${')) throw new AgentError('Invalid hook relay path')
  return p
}

/**
 * Claude Code settings with one command hook per event. Exec form (`args` set): Claude spawns `command` directly with
 * `args` as argv, no shell, so paths with spaces, quotes or `$` pass through verbatim. No matcher: every notification
 * type and every tool. `/usr/bin/env` sets ELECTRON_RUN_AS_NODE for the relay only, never for the agent itself.
 */
export function hookSettings(execPath: string, relayPath: string) {
  const handler = { type: 'command', command: '/usr/bin/env', args: ['ELECTRON_RUN_AS_NODE=1', checkPath(execPath), checkPath(relayPath)], timeout: HOOK_TIMEOUT_S }
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [handler] }]])) }
}

/**
 * Startup only, before any agent exists (no persistence yet): removes settings dirs a crash left behind.
 * Only real directories (lstat: symlinks are never followed) owned by this user and named by a UUID.
 */
export function removeStaleSettings(baseDir: string): void {
  let names: string[]
  try {
    names = readdirSync(baseDir)
  } catch {
    return // no base dir yet
  }
  const uid = process.getuid?.()
  for (const name of names) {
    if (!UUID_RE.test(name)) continue
    const p = join(baseDir, name)
    try {
      const st = lstatSync(p)
      if (st.isDirectory() && st.uid === uid) rmSync(p, { recursive: true, force: true })
    } catch {
      // vanished meanwhile
    }
  }
}

export type HookSession = { settingsPath: string; env: Record<string, string>; close(): void }

/** Per agent: a token on the listener plus `<baseDir>/<sessionId>/settings.json` (dir 0700, file 0600), outside any worktree. */
export class HookService {
  constructor(
    private listener: HookListener | null,
    private baseDir: string,
    private execPath: string,
    private relayPath: string,
  ) {}

  open(sessionId: string, onEvent: (s: HookSignal) => void): HookSession {
    if (!this.listener) throw new AgentError('Agent status is unavailable')
    if (!UUID_RE.test(sessionId)) throw new AgentError('Invalid session id')
    const content = JSON.stringify(hookSettings(this.execPath, this.relayPath), null, 2)
    const dir = join(this.baseDir, sessionId)
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    mkdirSync(dir, { mode: 0o700 }) // throws if it already exists
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, content, { mode: 0o600, flag: 'wx' })
    const reg = this.listener.register(onEvent)
    return {
      settingsPath,
      env: { AGENT_CANVAS_HOOK_SOCKET: this.listener.socketPath, AGENT_CANVAS_HOOK_TOKEN: reg.token },
      close: () => {
        reg.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }
}

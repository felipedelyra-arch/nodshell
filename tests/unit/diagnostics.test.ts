import { homedir, userInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from '../../src/main/diagnostics'

const input = { version: '1.2.3', electron: '45.3.2', chrome: '140.0.1', node: '22.1.0', platform: 'linux', arch: 'x64', consoles: 3, agents: 2, maxProcesses: 20 }

describe('buildDiagnostics', () => {
  it('has the expected fields', () => {
    const t = buildDiagnostics(input)
    for (const s of ['1.2.3', 'Electron 45.3.2', 'Chromium 140.0.1', 'Node 22.1.0', 'linux x64', 'Processes: 3', 'Agents: 2', 'Process limit: 20']) expect(t).toContain(s)
  })

  it('carries no home path, user name, repository name or environment', () => {
    const t = buildDiagnostics(input)
    expect(t).not.toContain(homedir())
    expect(t).not.toContain(userInfo().username)
    expect(t).not.toContain('demo repo')
    expect(t).not.toMatch(/PATH|HOME=/)
    expect(t).not.toMatch(/\/(home|tmp|Users)\//)
  })
})

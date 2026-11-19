import type { Failure } from './domain/webtile'
// Pure module (no electron): the text of "Found a bug?". Only these fields go in; no paths, user, repository, env or terminal content.
export type DiagnosticsInput = {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  consoles: number
  agents: number
  maxProcesses: number
  failures?: readonly Failure[]
}

export function buildDiagnostics(d: DiagnosticsInput): string {
  const failures = d.failures ?? []
  return [
    `NodShell ${d.version}`,
    `Electron ${d.electron} / Chromium ${d.chrome} / Node ${d.node}`,
    `Platform: ${d.platform} ${d.arch}`,
    `Processes: ${d.consoles}`,
    `Agents: ${d.agents}`,
    `Process limit: ${d.maxProcesses}`,
    'Recent failures:',
    ...(failures.length === 0 ? ['none'] : failures.map((f) => `${new Date(f.at).toISOString()} ${f.kind} ${f.reason} exit=${f.exitCode ?? 'n/a'}${f.type ? ` ${f.type}` : ''}`)),
  ].join('\n')
}

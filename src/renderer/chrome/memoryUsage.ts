// Pure logic of the Memory dialog's Usage tab and of the 80% warning.
import { statusPill } from '../../shared/agent'
import { isAlive, isTerminal, type AppNode } from '../graph'

export type MemoryReport = { bytes: number; app: number; terminals: { id: string; bytes: number }[]; system: { total: number; available: number } | null }
export type UsageRow = { id: string; name: string; kind: string; status: string; bytes: number; workspace: string }

export const WARN_AT = 80
export const REARM_BELOW = 75

/** Bytes in use, kept within 0..total (the test hook can report more available than the total). */
export const usedBytes = (system: NonNullable<MemoryReport['system']>) => Math.min(system.total, Math.max(0, system.total - system.available))

/** Whole percent of the system RAM in use; null when main could not read it. */
export function usedPercent(system: MemoryReport['system']): number | null {
  return system && system.total > 0 ? Math.round((usedBytes(system) / system.total) * 100) : null
}

/** Warn at 80% once; re-arm only after the use falls under 75% (no repeat every 5 s). */
export function nextWarning(percent: number | null, armed: boolean): { warn: boolean; armed: boolean } {
  if (percent === null) return { warn: false, armed }
  if (armed && percent >= WARN_AT) return { warn: true, armed: false }
  return { warn: false, armed: armed || percent < REARM_BELOW }
}

const MB = 1024 ** 2
export const formatMem = (b: number) => (b < 1024 * MB ? `${Math.round(b / MB)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`)
export const formatGB = (b: number) => (b / 1024 ** 3).toFixed(1)

/** One row per terminal the report knows, biggest first. */
export function usageRows(nodes: AppNode[], workspaces: { id: string; name: string }[], terminals: MemoryReport['terminals'], paused: boolean): UsageRow[] {
  const byId = new Map(nodes.filter(isTerminal).map((n) => [n.id, n]))
  return terminals
    .flatMap((t) => {
      const n = byId.get(t.id)
      if (!n) return []
      const d = n.data
      const status = statusPill(paused && isAlive(d) ? 'paused' : d.agent ? d.agent.state : d.status === 'exited' ? 'exited' : 'running').label
      return [{ id: t.id, name: d.name, kind: d.agent?.role ?? 'shell', status, bytes: t.bytes, workspace: workspaces.find((w) => w.id === d.workspaceId)?.name ?? '' }]
    })
    .sort((a, b) => b.bytes - a.bytes)
}

import { readdirSync, readFileSync } from 'node:fs'

/** Pids whose session id is `sid` (Linux /proc; best effort, empty elsewhere). */
export function pidsInSession(sid: number): number[] {
  const pids: number[] = []
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        // fields after the ")" that closes comm: state ppid pgrp session ...
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (Number(rest[3]) === sid) pids.push(Number(name))
      } catch {
        // process vanished
      }
    }
  } catch {
    // no /proc
  }
  return pids
}

export function signal(pid: number, sig: NodeJS.Signals, group = false): void {
  try {
    process.kill(group ? -pid : pid, sig)
  } catch {
    // already gone
  }
}

const PAGE = 4096 // Linux page size on every target we ship (x86-64, arm64 4K); only feeds a display figure

/** Resident bytes per session id in `sids`, in one pass over /proc (stat field 24 is the RSS in pages). Best effort: empty without /proc. */
export function sessionRssBy(sids: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (sids.length === 0) return out
  const want = new Set(sids)
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const sid = Number(rest[3])
        if (want.has(sid)) out.set(sid, (out.get(sid) ?? 0) + (Number(rest[21]) || 0) * PAGE)
      } catch {
        // process vanished
      }
    }
  } catch {
    // no /proc
  }
  return out
}

/** Total physical memory (MemTotal), or null where /proc/meminfo does not say. */
export function totalBytes(): number | null {
  try {
    const kb = /^MemTotal:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
    return kb ? Number(kb) * 1024 : null
  } catch {
    return null
  }
}

/** Memory the system can still hand out without swapping (MemAvailable), or null where /proc/meminfo does not say. */
export function availableBytes(): number | null {
  try {
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]
    return kb ? Number(kb) * 1024 : null
  } catch {
    return null
  }
}

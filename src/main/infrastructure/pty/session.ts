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

/** Resident bytes of all processes whose session id is in `sids`, in one pass over /proc (stat field 24 is the RSS in pages). Best effort: 0 without /proc. */
export function sessionRss(sids: number[]): number {
  if (sids.length === 0) return 0
  const want = new Set(sids)
  let pages = 0
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (want.has(Number(rest[3]))) pages += Number(rest[21]) || 0
      } catch {
        // process vanished
      }
    }
  } catch {
    // no /proc
  }
  return pages * PAGE
}

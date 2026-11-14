import { describe, expect, it, vi } from 'vitest'
import { MAX_PTYS, PtyManager, type PtyProc, type Timing } from '../../src/main/infrastructure/pty/manager'

class FakePty implements PtyProc {
  static nextPid = 900_000
  pid = FakePty.nextPid++
  writes: string[] = []
  paused = false
  private dataCb: (d: string) => void = () => undefined
  private exitCb: (e: { exitCode: number }) => void = () => undefined
  /** When true, SIGHUP/SIGKILL (via the fake signal fn) make it exit. */
  exitsOn: 'SIGHUP' | 'SIGKILL' | 'never' = 'SIGHUP'
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  write(d: string) { this.writes.push(d) }
  resize() {}
  pause() { this.paused = true }
  resume() { this.paused = false }
  emit(d: string) { this.dataCb(d) }
  die() { this.exitCb({ exitCode: 0 }) }
}

function setup(timing: Partial<Timing> = {}) {
  const ptys: FakePty[] = []
  const signals: { pid: number; sig: string }[] = []
  const sent: { owner: number; event: string; payload: unknown }[] = []
  const t: Timing = {
    graceMs: 10,
    hardMs: 60,
    sessionPids: () => [],
    signal: (pid, sig) => {
      signals.push({ pid, sig })
      const p = ptys.find((x) => x.pid === pid)
      if (p && (p.exitsOn === sig || (sig === 'SIGKILL' && p.exitsOn === 'SIGHUP'))) p.die()
    },
    ...timing,
  }
  const mgr = new PtyManager(
    (owner, event, payload) => sent.push({ owner, event, payload }),
    () => { const p = new FakePty(); ptys.push(p); return p },
    t,
  )
  return { mgr, ptys, signals, sent }
}

describe('PtyManager ownership', () => {
  it('rejects write/resize/kill/ack from another owner with the same error as an unknown id', async () => {
    const { mgr } = setup()
    const { id } = mgr.spawn(1, 80, 24)
    const unknown = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
    const msg = (fn: () => unknown) => { try { fn(); return 'no error' } catch (e) { return (e as Error).message } }
    expect(msg(() => mgr.write(2, id, 'x'))).toBe(msg(() => mgr.write(1, unknown, 'x')))
    expect(msg(() => mgr.resize(2, id, 80, 24))).toBe(msg(() => mgr.resize(1, unknown, 80, 24)))
    expect(msg(() => mgr.ack(2, id, 5))).toBe(msg(() => mgr.ack(1, unknown, 5)))
    await expect(mgr.kill(2, id)).rejects.toThrow('Unknown terminal')
    expect(mgr.size).toBe(1)
  })
})

describe('PtyManager limit', () => {
  it('rejects the 13th spawn and frees a slot after kill', async () => {
    const { mgr } = setup()
    const ids = Array.from({ length: MAX_PTYS }, () => mgr.spawn(1, 80, 24).id)
    expect(() => mgr.spawn(1, 80, 24)).toThrow(/limit/i)
    await mgr.kill(1, ids[0]!)
    expect(() => mgr.spawn(1, 80, 24)).not.toThrow()
  })
})

describe('PtyManager configurable limit', () => {
  it('a lower limit kills nothing and only refuses new terminals; a higher one admits more', () => {
    const { mgr } = setup()
    for (let i = 0; i < 5; i++) mgr.spawn(1, 80, 24)
    mgr.limit = 3
    expect(mgr.size).toBe(5)
    expect(() => mgr.spawn(1, 80, 24)).toThrow('Terminal limit reached (3)')
    mgr.limit = 6
    expect(() => mgr.spawn(1, 80, 24)).not.toThrow()
    expect(() => mgr.spawn(1, 80, 24)).toThrow('Terminal limit reached (6)')
    expect(mgr.pids()).toHaveLength(6)
  })
})

describe('PtyManager.killOwned', () => {
  it('only touches that owner', async () => {
    const { mgr, ptys, signals } = setup()
    mgr.spawn(1, 80, 24)
    mgr.spawn(2, 80, 24)
    mgr.spawn(1, 80, 24)
    await mgr.killOwned(1)
    const hupped = signals.filter((s) => s.sig === 'SIGHUP').map((s) => s.pid)
    expect(hupped.sort()).toEqual([ptys[0]!.pid, ptys[2]!.pid].sort())
    expect(mgr.size).toBe(1)
  })
})

describe('PtyManager bounded kill', () => {
  it('resolves even if the PTY never reports exit, and frees the slot', async () => {
    const { mgr, ptys, signals } = setup()
    const { id } = mgr.spawn(1, 80, 24)
    ptys[0]!.exitsOn = 'never'
    const started = Date.now()
    await mgr.kill(1, id)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(signals.map((s) => s.sig)).toEqual(expect.arrayContaining(['SIGHUP', 'SIGKILL']))
    expect(mgr.size).toBe(0)
  })
  it('killAll resolves with a stuck PTY', async () => {
    const { mgr, ptys } = setup()
    mgr.spawn(1, 80, 24)
    ptys[0]!.exitsOn = 'never'
    await expect(mgr.killAll()).resolves.toBeUndefined()
  })
})

describe('PtyManager flow control', () => {
  it('pauses above the high watermark and resumes after acks', async () => {
    vi.useFakeTimers()
    try {
      const { mgr, ptys, sent } = setup()
      const { id } = mgr.spawn(1, 80, 24)
      const big = 'x'.repeat(450_000)
      ptys[0]!.emit(big)
      await vi.advanceTimersByTimeAsync(20)
      expect(sent.filter((s) => s.event === 'pty:data')).toHaveLength(1)
      expect(ptys[0]!.paused).toBe(true)
      mgr.ack(1, id, 200_000)
      expect(ptys[0]!.paused).toBe(true) // 250k still unacknowledged
      mgr.ack(1, id, 200_000)
      expect(ptys[0]!.paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PtyManager agent commands', () => {
  const cmd = { file: '/usr/bin/claude', args: ['--session-id=x'], env: { PATH: '/bin' }, cwd: '/wt' }
  it('agents count toward the same limit as consoles', () => {
    const { mgr } = setup()
    for (let i = 0; i < MAX_PTYS - 1; i++) mgr.spawn(1, 80, 24)
    mgr.spawnCommand(1, 80, 24, cmd)
    expect(() => mgr.spawnCommand(1, 80, 24, cmd)).toThrow(/limit/i)
    expect(() => mgr.spawn(1, 80, 24)).toThrow(/limit/i)
  })
  it('handle checks ownership up front and liveness on every write', async () => {
    const { mgr, ptys } = setup()
    const id = mgr.spawnCommand(1, 80, 24, cmd)
    expect(() => mgr.handle(2, id)).toThrow('Unknown terminal')
    const h = mgr.handle(1, id)
    h.write('a')
    expect(ptys[0]!.writes).toEqual(['a'])
    await mgr.kill(1, id)
    expect(h.alive()).toBe(false)
    h.write('b')
    expect(ptys[0]!.writes).toEqual(['a'])
  })
})

describe('PtyManager.recentText (scrape fallback)', () => {
  it('keeps a bounded tail of the raw output, cleaned, for the owner only', () => {
    const { mgr, ptys } = setup()
    const { id } = mgr.spawn(1, 80, 24)
    ptys[0]!.emit('x'.repeat(200_000) + '\r\n')
    ptys[0]!.emit('\x1b[32mAnswer:\x1b[0m done\r\n')
    expect(mgr.recentText(1, id).endsWith('Answer: done')).toBe(true)
    expect(mgr.recentText(1, id).length).toBeLessThanOrEqual(8000)
    expect(mgr.recentText(2, id)).toBe('')
    ptys[0]!.die()
    expect(mgr.recentText(1, id)).toBe('')
  })
})

describe('PtyManager.busy (console close confirmation)', () => {
  it('is true only while the shell has another process in its session', () => {
    let others: number[] = []
    const { mgr, ptys } = setup({ sessionPids: (sid) => [sid, ...others] })
    const { id } = mgr.spawn(1, 80, 24)
    expect(mgr.busy(1, id)).toBe(false)
    others = [ptys[0]!.pid + 1]
    expect(mgr.busy(1, id)).toBe(true)
    expect(() => mgr.busy(2, id)).toThrow('Unknown terminal')
    // the window-close and quit confirmation asks per window or for all
    expect(mgr.anyBusy(1)).toBe(true)
    expect(mgr.anyBusy()).toBe(true)
    expect(mgr.anyBusy(2)).toBe(false)
    others = []
    expect(mgr.anyBusy()).toBe(false)
  })
})

describe('PtyManager pause all (SIGSTOP / SIGCONT)', () => {
  it('stops the process group of each terminal of that window and the rest of its session; continues them in reverse', () => {
    const extra = new Map<number, number[]>()
    const { mgr, ptys, signals } = setup({ sessionPids: (sid) => [sid, ...(extra.get(sid) ?? [])] })
    mgr.spawn(1, 80, 24)
    mgr.spawnCommand(1, 80, 24, { file: '/usr/bin/claude', args: [], env: {}, cwd: '/wt' })
    mgr.spawn(2, 80, 24)
    extra.set(ptys[0]!.pid, [42]) // a console's foreground job, in its own group
    mgr.stopOwned(1)
    expect(mgr.isStopped(1)).toBe(true)
    expect(mgr.isStopped(2)).toBe(false)
    expect(signals).toEqual([
      { pid: ptys[0]!.pid, sig: 'SIGSTOP' },
      { pid: 42, sig: 'SIGSTOP' },
      { pid: ptys[1]!.pid, sig: 'SIGSTOP' },
    ])
    signals.length = 0
    mgr.contOwned(1)
    expect(signals).toEqual([
      { pid: 42, sig: 'SIGCONT' },
      { pid: ptys[0]!.pid, sig: 'SIGCONT' },
      { pid: ptys[1]!.pid, sig: 'SIGCONT' },
    ])
    expect(mgr.isStopped(1)).toBe(false)
  })
  it('sends the group signals to the process group (negative pid)', () => {
    const calls: { pid: number; sig: string; group?: boolean }[] = []
    const { mgr, ptys } = setup({ signal: (pid, sig, group) => void calls.push({ pid, sig, group }) })
    mgr.spawn(1, 80, 24)
    mgr.stopOwned(1)
    expect(calls).toEqual([{ pid: ptys[0]!.pid, sig: 'SIGSTOP', group: true }])
  })
  it('refuses new terminals while paused, for that window only', () => {
    const { mgr } = setup()
    mgr.spawn(1, 80, 24)
    mgr.stopOwned(1)
    expect(() => mgr.spawn(1, 80, 24)).toThrow('Everything is paused, resume all first')
    expect(() => mgr.spawnCommand(1, 80, 24, { file: '/x', args: [], env: {}, cwd: '/wt' })).toThrow('paused')
    expect(() => mgr.spawn(2, 80, 24)).not.toThrow()
    mgr.contOwned(1)
    expect(() => mgr.spawn(1, 80, 24)).not.toThrow()
  })
  it('closing a stopped terminal continues it before the hangup, so nothing is left stopped; closing the window clears the pause', async () => {
    const { mgr, ptys, signals } = setup()
    const { id } = mgr.spawn(1, 80, 24)
    mgr.spawn(1, 80, 24)
    mgr.stopOwned(1)
    signals.length = 0
    await mgr.kill(1, id)
    expect(signals.slice(0, 2)).toEqual([
      { pid: ptys[0]!.pid, sig: 'SIGCONT' },
      { pid: ptys[0]!.pid, sig: 'SIGHUP' },
    ])
    expect(mgr.isStopped(1)).toBe(true) // the other one is still paused
    await mgr.killOwned(1)
    expect(signals.filter((s) => s.pid === ptys[1]!.pid).map((s) => s.sig).slice(0, 2)).toEqual(['SIGCONT', 'SIGHUP'])
    expect(mgr.isStopped(1)).toBe(false)
    expect(mgr.size).toBe(0)
  })
  it('killAll (quit) continues every stopped terminal first', async () => {
    const { mgr, ptys, signals } = setup()
    mgr.spawn(1, 80, 24)
    mgr.spawn(2, 80, 24)
    mgr.stopOwned(1)
    mgr.stopOwned(2)
    signals.length = 0
    await mgr.killAll()
    for (const p of ptys) {
      const mine = signals.filter((s) => s.pid === p.pid).map((s) => s.sig)
      expect(mine.indexOf('SIGCONT')).toBeLessThan(mine.indexOf('SIGHUP'))
    }
  })
})

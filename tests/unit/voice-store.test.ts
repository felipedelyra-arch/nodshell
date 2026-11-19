import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLD_MS, TAIL_MS } from '../../src/shared/voice'
import type { Recorder } from '../../src/renderer/command/recorder'

type Mock = { rec: Recorder; abort: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }
let opens: { resolve(m: Mock): void; reject(e: unknown): void }[] = []
vi.mock('../../src/renderer/command/recorder', () => ({
  startRecorder: () => new Promise<Recorder>((resolve, reject) => opens.push({ resolve: (m) => resolve(m.rec), reject })),
}))

const invoke = vi.fn()
const mk = (): Mock => {
  const abort = vi.fn()
  const finish = vi.fn(async () => new Uint8Array(1_000_000))
  return { rec: { abort, finish, level: () => 0 }, abort, finish }
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

describe('command store: voice paths', () => {
  let useCommand: typeof import('../../src/renderer/command/store').useCommand
  beforeEach(async () => {
    vi.useFakeTimers()
    opens = []
    invoke.mockReset().mockResolvedValue({ text: 'hello' })
    Object.assign(globalThis, { window: { api: { invoke }, addEventListener: () => undefined }, document: { activeElement: null, addEventListener: () => undefined } })
    ;({ useCommand } = await import('../../src/renderer/command/store'))
    useCommand.setState({ voiceAvailable: true, text: {}, notes: {} })
  })
  afterEach(() => {
    useCommand.getState().voiceBlur()
    vi.useRealTimers()
    vi.resetModules()
  })

  it('a tap (key released before HOLD_MS) aborts the late-opening recorder and transcribes nothing', async () => {
    const m = mk()
    useCommand.getState().voiceDown('space', 'global')
    await tick(50)
    useCommand.getState().voiceUp('space')
    opens[0]?.resolve(m)
    await tick(10)
    expect(m.abort).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
    expect(useCommand.getState().voice.status).toBe('idle')
  })

  it('a blur during arming aborts the recorder that opens afterwards', async () => {
    const m = mk()
    useCommand.getState().voiceDown('space', 'global')
    useCommand.getState().voiceBlur()
    opens[0]?.resolve(m)
    await tick(10)
    expect(m.abort).toHaveBeenCalledTimes(1)
    expect(m.finish).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('an open that fails while the tail runs goes back to idle with an error note and nothing dangling', async () => {
    useCommand.getState().voiceDown('space', 'global')
    await tick(HOLD_MS)
    useCommand.getState().voiceUp('space')
    await tick(TAIL_MS)
    opens[0]?.reject(new Error('denied'))
    await tick(10)
    const s = useCommand.getState()
    expect(s.voice.status).toBe('idle')
    expect(s.notes['global']?.kind).toBe('error')
    expect(invoke).not.toHaveBeenCalled()
    // a new dictation can start: the machine is not stuck
    s.voiceDown('space', 'global')
    expect(opens).toHaveLength(2)
  })

  it('a second source cannot end the first source recording', async () => {
    const m = mk()
    const s = useCommand.getState()
    s.voiceDown('mic:global', 'global', true)
    opens[0]?.resolve(m)
    await tick(HOLD_MS)
    s.voiceDown('space', 'global') // ignored: another source
    s.voiceUp('space')
    s.voiceAbort('mic:other')
    await tick(TAIL_MS + 10)
    expect(m.finish).not.toHaveBeenCalled()
    expect(m.abort).not.toHaveBeenCalled()
    expect(useCommand.getState().voice.status).toBe('listening')
  })

  it('aborting the source ends its recording at once: tracks dropped, no transcription', async () => {
    const m = mk()
    const s = useCommand.getState()
    s.voiceDown('mic:squad:1', 'squad:1', true)
    opens[0]?.resolve(m)
    await tick(HOLD_MS)
    s.voiceUp('mic:squad:1') // tap: stays listening
    expect(useCommand.getState().voice.status).toBe('listening')
    s.voiceAbort('mic:squad:1')
    await tick(TAIL_MS + 10)
    expect(m.abort).toHaveBeenCalledTimes(1)
    expect(m.finish).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(useCommand.getState().voice).toEqual({ status: 'idle', target: null })
  })
})

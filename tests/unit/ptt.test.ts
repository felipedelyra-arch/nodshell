import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtt } from '../../src/renderer/command/ptt'
import { HOLD_MS, TAIL_MS } from '../../src/shared/voice'

function setup() {
  const calls: string[] = []
  let settle: () => void = () => undefined
  const ptt = createPtt({
    open: () => void calls.push('open'),
    show: () => void calls.push('show'),
    discard: () => void calls.push('discard'),
    lost: () => void calls.push('lost'),
    fail: () => void calls.push('fail'),
    finish: () => {
      calls.push('finish')
      return new Promise<void>((r) => (settle = r))
    },
  })
  return { ptt, calls, settle: () => settle() }
}

describe('push-to-talk timing', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens the microphone at press and shows listening only after HOLD_MS', () => {
    const { ptt, calls } = setup()
    ptt.send({ t: 'down', src: 'space' })
    expect(calls).toEqual(['open'])
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(calls).toEqual(['open'])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['open', 'show'])
  })

  it('a tap shorter than HOLD_MS is discarded and requests nothing', () => {
    const { ptt, calls } = setup()
    ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(100)
    ptt.send({ t: 'up', src: 'space' })
    vi.advanceTimersByTime(5000)
    expect(calls).toEqual(['open', 'discard'])
    expect(ptt.phase()).toBe('idle')
  })

  it('finishes exactly TAIL_MS after release', () => {
    const { ptt, calls } = setup()
    ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(2000)
    ptt.send({ t: 'up', src: 'space' })
    vi.advanceTimersByTime(TAIL_MS - 1)
    expect(calls).not.toContain('finish')
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['open', 'show', 'finish'])
    expect(ptt.phase()).toBe('busy')
  })

  it('pressing again inside the tail continues one recording', () => {
    const { ptt, calls } = setup()
    ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(1000)
    ptt.send({ t: 'up', src: 'space' })
    vi.advanceTimersByTime(TAIL_MS - 50)
    ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(5000)
    expect(calls).toEqual(['open', 'show'])
    ptt.send({ t: 'up', src: 'space' })
    vi.advanceTimersByTime(TAIL_MS)
    expect(calls).toEqual(['open', 'show', 'finish'])
  })

  it('blur finishes at once, without the tail; a blur during a tap discards', () => {
    const a = setup()
    a.ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(1000)
    a.ptt.send({ t: 'blur' })
    expect(a.calls).toEqual(['open', 'show', 'finish'])
    vi.advanceTimersByTime(5000)
    expect(a.calls).toEqual(['open', 'show', 'finish'])
    a.settle()
    const b = setup()
    b.ptt.send({ t: 'down', src: 'space' })
    b.ptt.send({ t: 'blur' })
    expect(b.calls).toEqual(['open', 'discard'])
  })

  it('another source cannot end or continue a recording', () => {
    const { ptt, calls } = setup()
    ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(1000)
    ptt.send({ t: 'down', src: 'mic:global', toggle: true })
    ptt.send({ t: 'up', src: 'mic:global' })
    vi.advanceTimersByTime(5000)
    expect(calls).toEqual(['open', 'show'])
    ptt.send({ t: 'up', src: 'space' })
    ptt.send({ t: 'down', src: 'mic:global' }) // not the owner: does not cancel the tail
    vi.advanceTimersByTime(TAIL_MS)
    expect(calls).toEqual(['open', 'show', 'finish'])
  })

  it('the microphone button: a tap starts, the next tap stops after the tail', () => {
    const { ptt, calls, settle } = setup()
    ptt.send({ t: 'down', src: 'mic:a', toggle: true })
    vi.advanceTimersByTime(80)
    ptt.send({ t: 'up', src: 'mic:a' })
    expect(calls).toEqual(['open', 'show'])
    vi.advanceTimersByTime(3000)
    ptt.send({ t: 'down', src: 'mic:a', toggle: true })
    ptt.send({ t: 'up', src: 'mic:a' })
    vi.advanceTimersByTime(TAIL_MS)
    expect(calls).toEqual(['open', 'show', 'finish'])
    settle()
  })

  it('back to idle after the transcription settles; a device loss finishes and warns', async () => {
    const { ptt, calls, settle } = setup()
    ptt.send({ t: 'down', src: 'space' })
    vi.advanceTimersByTime(1000)
    ptt.send({ t: 'lost' })
    expect(calls).toEqual(['open', 'show', 'finish', 'lost'])
    settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(ptt.phase()).toBe('idle')
  })
})

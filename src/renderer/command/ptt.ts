import { HOLD_MS, TAIL_MS } from '../../shared/voice'

// Push-to-talk timing: capture starts at press (arming), shows "listening" after HOLD_MS, keeps going TAIL_MS after release.
export type Phase = 'idle' | 'arming' | 'listening' | 'tail' | 'busy'
export type Ptt = { phase: Phase; src: string; toggle: boolean; down: boolean }
export type PttEvent =
  | { t: 'down'; src: string; toggle?: boolean | undefined } // toggle: a tap on this source starts, the next tap stops (microphone button)
  | { t: 'up'; src: string }
  | { t: 'abort'; src: string } // the control that started the recording went away: drop it, no transcription
  | { t: 'hold' | 'tail' | 'blur' | 'limit' | 'lost' | 'failed' | 'done' }
export type Fx = 'clear' | 'open' | 'armHold' | 'show' | 'startTail' | 'discard' | 'finish' | 'lost' | 'fail'

const idle: Ptt = { phase: 'idle', src: '', toggle: false, down: false }

/** Pure rules: the next state and what to do. Only the source that started a recording can continue or end it. */
export function step(s: Ptt, e: PttEvent): [Ptt, Fx[]] {
  const mine = (e.t === 'down' || e.t === 'up' || e.t === 'abort') && e.src === s.src
  const stop = (extra: Fx[] = []): [Ptt, Fx[]] => [{ ...s, phase: 'busy' }, ['clear', 'finish', ...extra]]
  switch (s.phase) {
    case 'idle':
      return e.t === 'down' ? [{ phase: 'arming', src: e.src, toggle: !!e.toggle, down: true }, ['open', 'armHold']] : [s, []]
    case 'arming':
      if (e.t === 'hold') return [{ ...s, phase: 'listening' }, ['show']]
      if (e.t === 'up' && mine) return s.toggle ? [{ ...s, phase: 'listening', down: false }, ['clear', 'show']] : [idle, ['clear', 'discard']] // a tap
      if (e.t === 'blur' || (e.t === 'abort' && mine)) return [idle, ['clear', 'discard']]
      if (e.t === 'lost') return [idle, ['clear', 'discard', 'lost']]
      if (e.t === 'failed') return [idle, ['clear', 'fail']]
      return [s, []]
    case 'listening':
      if (e.t === 'down' && mine && !s.down) return [{ ...s, down: true }, []]
      if (e.t === 'up' && mine && s.down) return [{ ...s, phase: 'tail', down: false }, ['startTail']]
      if (e.t === 'abort' && mine) return [idle, ['clear', 'discard']]
      if (e.t === 'blur' || e.t === 'limit') return stop()
      if (e.t === 'lost') return stop(['lost'])
      if (e.t === 'failed') return [idle, ['clear', 'fail']]
      return [s, []]
    case 'tail':
      if (e.t === 'down' && mine) return [{ ...s, phase: 'listening', down: true }, ['clear']] // push-to-talk debounce
      if (e.t === 'abort' && mine) return [idle, ['clear', 'discard']]
      if (e.t === 'tail' || e.t === 'blur' || e.t === 'limit') return stop()
      if (e.t === 'lost') return stop(['lost'])
      return [s, []]
    case 'busy':
      return e.t === 'done' ? [idle, []] : [s, []]
  }
}

export type PttIo = {
  open(): void
  show(): void
  discard(): void
  /** drains and transcribes; the machine goes back to idle when it settles */
  finish(): Promise<void>
  lost(): void
  fail(): void
}

export function createPtt(io: PttIo) {
  let s = idle
  let hold: ReturnType<typeof setTimeout> | undefined
  let tail: ReturnType<typeof setTimeout> | undefined
  const send = (e: PttEvent): void => {
    const [next, fx] = step(s, e)
    s = next
    for (const f of fx) {
      if (f === 'clear') {
        clearTimeout(hold)
        clearTimeout(tail)
      } else if (f === 'armHold') hold = setTimeout(() => send({ t: 'hold' }), HOLD_MS)
      else if (f === 'startTail') tail = setTimeout(() => send({ t: 'tail' }), TAIL_MS)
      else if (f === 'finish') void io.finish().finally(() => send({ t: 'done' }))
      else io[f]()
    }
  }
  return { send, phase: (): Phase => s.phase }
}

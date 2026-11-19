// One global subscription per event; routes PTY output to the terminal that owns the id.
// Output that arrives before the xterm instance mounts is buffered until `attach`.
// Once mounted, output goes through one shared per-frame pump (see pump.ts) instead of straight into xterm.
import { createPump } from './pump'

type Sink = { write: (data: string) => void; exit: (code: number) => void; dropped?: (chars: number) => void }
type Pending = { data: string[]; exit?: number }

const FRAME_BUDGET = 48_000 // characters handed to xterm per frame, all terminals together

const sinks = new Map<string, Sink>()
const pending = new Map<string, Pending>()

const pump = createPump({
  write: (id, data) => sinks.get(id)?.write(data),
  exit: (id, code) => sinks.get(id)?.exit(code),
  // rAF does not fire while the window is hidden, so a timer races it: output must never stall there
  schedule: (run) => {
    let done = false
    const once = () => {
      if (done) return
      done = true
      run()
    }
    requestAnimationFrame(once)
    setTimeout(once, 100)
  },
  budget: () => (document.hidden ? Infinity : FRAME_BUDGET),
})

export function startBus(onExit: (id: string, code: number) => void): () => void {
  const offData = window.api.on('pty:data', ({ id, data }) => {
    if (sinks.has(id)) pump.enqueue(id, data)
    else (pending.get(id) ?? pending.set(id, { data: [] }).get(id)!).data.push(data)
  })
  const offExit = window.api.on('pty:exit', ({ id, code }) => {
    onExit(id, code)
    if (sinks.has(id)) pump.enqueue(id, { exit: code })
    else (pending.get(id) ?? pending.set(id, { data: [] }).get(id)!).exit = code
  })
  return () => {
    offData()
    offExit()
  }
}

export function attach(id: string, sink: Sink): () => void {
  const p = pending.get(id)
  pending.delete(id)
  sinks.set(id, sink)
  p?.data.forEach((d) => pump.enqueue(id, d))
  if (p?.exit !== undefined) pump.enqueue(id, { exit: p.exit })
  return () => {
    sinks.delete(id)
    const chars = pump.drop(id)
    if (chars > 0) sink.dropped?.(chars)
  }
}

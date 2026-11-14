// One global subscription per event; routes PTY output to the terminal that owns the id.
// Output that arrives before the xterm instance mounts is buffered until `attach`.
type Sink = { write: (data: string) => void; exit: (code: number) => void }
type Pending = { data: string[]; exit?: number }

const sinks = new Map<string, Sink>()
const pending = new Map<string, Pending>()

export function startBus(onExit: (id: string, code: number) => void): () => void {
  const offData = window.api.on('pty:data', ({ id, data }) => {
    const s = sinks.get(id)
    if (s) s.write(data)
    else (pending.get(id) ?? pending.set(id, { data: [] }).get(id)!).data.push(data)
  })
  const offExit = window.api.on('pty:exit', ({ id, code }) => {
    onExit(id, code)
    const s = sinks.get(id)
    if (s) s.exit(code)
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
  p?.data.forEach(sink.write)
  if (p?.exit !== undefined) sink.exit(p.exit)
  sinks.set(id, sink)
  return () => void sinks.delete(id)
}

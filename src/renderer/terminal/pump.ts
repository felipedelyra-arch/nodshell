// Hands PTY output to xterm with ONE budget per frame shared by all terminals.
// xterm parses what it is given in its own time slices; with N busy terminals those slices queue back to back and a frame costs N x slice.
// Limiting the characters handed over per frame bounds that cost; what is not handed over waits here and stays unacked,
// so main's flow control (pause/resume of the PTY) bounds the queue. DOM-free: frame scheduling is injected.
type Item = string | { exit: number }
export type PumpDeps = {
  write: (id: string, data: string) => void
  exit: (id: string, code: number) => void
  schedule: (run: () => void) => void
  budget: () => number // characters per frame (Infinity while the window is hidden: frames do not fire then)
}

const QUANTUM = 8_192 // characters one terminal gets per round-robin turn

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff

export function createPump(d: PumpDeps) {
  const queues = new Map<string, Item[]>()
  const ready: string[] = [] // terminals with queued items, in turn order
  let scheduled = false

  const arm = () => {
    if (scheduled) return
    scheduled = true
    d.schedule(tick)
  }
  function tick() {
    scheduled = false
    let left = d.budget()
    while (left > 0 && ready.length) {
      const id = ready.shift()!
      const q = queues.get(id)
      if (!q) continue
      let take = Math.min(QUANTUM, left)
      let text = ''
      while (q.length && take > 0) {
        const it = q[0]!
        if (typeof it !== 'string') {
          if (text) break // the exit message follows all its data
          q.shift()
          d.exit(id, it.exit)
          continue
        }
        let n = Math.min(it.length, take)
        if (n > 1 && n < it.length && isHighSurrogate(it.charCodeAt(n - 1))) n-- // never split a surrogate pair
        text += it.slice(0, n)
        take = n === it.length ? take - n : 0
        if (n === it.length) q.shift()
        else q[0] = it.slice(n)
      }
      if (text) {
        left -= text.length
        d.write(id, text)
      }
      if (q.length) ready.push(id)
      else queues.delete(id)
    }
    if (ready.length) arm()
  }
  return {
    enqueue(id: string, item: Item) {
      const q = queues.get(id)
      if (q) q.push(item)
      else {
        queues.set(id, [item])
        ready.push(id)
      }
      arm()
    },
    /** Drops what is still queued for a terminal that went away; returns the characters discarded (the caller acks them). */
    drop(id: string): number {
      const chars = (queues.get(id) ?? []).reduce((n, it) => n + (typeof it === 'string' ? it.length : 0), 0)
      queues.delete(id)
      const i = ready.indexOf(id)
      if (i >= 0) ready.splice(i, 1)
      return chars
    },
  }
}

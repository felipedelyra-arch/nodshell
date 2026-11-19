import { describe, expect, it } from 'vitest'
import { createPump } from '../../src/renderer/terminal/pump'

function setup(budget = 100) {
  const log: string[] = []
  const written = new Map<string, string>()
  let frame: (() => void) | undefined
  const pump = createPump({
    write: (id, data) => {
      written.set(id, (written.get(id) ?? '') + data)
      log.push(`w:${id}:${data.length}`)
    },
    exit: (id, code) => log.push(`x:${id}:${code}`),
    schedule: (run) => (frame = run),
    budget: () => budget,
  })
  const frames = (after: (n: number) => number = (n) => n) => {
    let n = 0
    while (frame) {
      const f = frame
      frame = undefined
      f()
      n = after(n + 1)
    }
    return n
  }
  return { pump, log, written, frames }
}

describe('terminal output pump', () => {
  it('keeps order per terminal and loses nothing', () => {
    const { pump, written, frames } = setup(50_000)
    const a = Array.from({ length: 40 }, (_, i) => `a${i};`.repeat(500))
    a.forEach((s) => pump.enqueue('a', s))
    pump.enqueue('b', 'hello')
    frames()
    expect(written.get('a')).toBe(a.join(''))
    expect(written.get('b')).toBe('hello')
  })

  it('shares each frame round-robin so no terminal starves', () => {
    const { pump, log, frames } = setup(100)
    pump.enqueue('a', 'a'.repeat(10_000))
    pump.enqueue('b', 'b'.repeat(300))
    const n = frames()
    // b finishes in its first turns even though a has far more queued
    const lastB = log.map((e, i) => (e.startsWith('w:b') ? i : -1)).reduce((m, i) => Math.max(m, i), -1)
    const lastA = log.map((e, i) => (e.startsWith('w:a') ? i : -1)).reduce((m, i) => Math.max(m, i), -1)
    expect(lastB).toBeLessThan(lastA)
    const total = log.filter((e) => e.startsWith('w:')).reduce((s, e) => s + Number(e.split(':')[2]), 0)
    expect(total).toBe(10_300)
    expect(n).toBeGreaterThan(100) // 10_300 chars at <= 100 per frame
  })

  it('caps every frame at the budget', () => {
    const { pump, log, frames } = setup(100)
    pump.enqueue('a', 'a'.repeat(250))
    pump.enqueue('b', 'b'.repeat(250))
    const sizes: number[] = []
    let last = 0
    // step frame by frame through the injected scheduler
    const total = () => log.reduce((n, e) => n + Number(e.split(':')[2]), 0)
    frames((i) => {
      sizes.push(total() - last)
      last = total()
      return i
    })
    expect(sizes.every((n) => n <= 100)).toBe(true)
    expect(total()).toBe(500)
  })

  it('delivers exit after all data of that terminal', () => {
    const { pump, log, frames } = setup(10)
    pump.enqueue('a', 'a'.repeat(35))
    pump.enqueue('a', { exit: 3 })
    frames()
    expect(log[log.length - 1]).toBe('x:a:3')
    expect(log.filter((e) => e.startsWith('w:a')).length).toBeGreaterThan(1)
  })

  it('does not split a surrogate pair', () => {
    const { pump, written, log, frames } = setup(3)
    pump.enqueue('a', 'ab\u{1F600}cd')
    frames()
    expect(written.get('a')).toBe('ab\u{1F600}cd')
    expect(log[0]).toBe('w:a:2')
  })

  it('drop discards what is queued and returns the character count', () => {
    const { pump, written, frames } = setup(10)
    pump.enqueue('a', 'a'.repeat(100))
    pump.enqueue('a', { exit: 1 })
    expect(pump.drop('a')).toBe(100)
    expect(pump.drop('nope')).toBe(0)
    frames()
    expect(written.get('a')).toBeUndefined()
  })

  it('delivers a new enqueue after drop (remount) without the dropped text', () => {
    const { pump, written, frames } = setup(10)
    pump.enqueue('a', 'old'.repeat(50))
    pump.drop('a')
    pump.enqueue('a', 'new')
    frames()
    expect(written.get('a')).toBe('new')
  })
})

import { describe, expect, it } from 'vitest'
import { formatMem, nextWarning, usageRows, usedPercent } from '../../src/renderer/chrome/memoryUsage'
import type { AppNode } from '../../src/renderer/graph'

const GB = 1024 ** 3
describe('memory usage', () => {
  it('percent used', () => {
    expect(usedPercent({ total: 16 * GB, available: 4 * GB })).toBe(75)
    expect(usedPercent(null)).toBeNull()
    expect(usedPercent({ total: 10, available: 99 })).toBe(0)
    expect(usedPercent({ total: 0, available: 0 })).toBeNull()
  })
  it('warns once at 80% and re-arms under 75%', () => {
    let s = { warn: false, armed: true }
    const seq: [number, boolean][] = [[70, false], [80, true], [85, false], [78, false], [76, false], [74, false], [81, true]]
    for (const [p, warn] of seq) {
      s = nextWarning(p, s.armed)
      expect(s.warn, `at ${p}`).toBe(warn)
    }
    expect(nextWarning(null, false)).toEqual({ warn: false, armed: false })
  })
  it('formats MB below 1024 MB, GB above', () => {
    expect(formatMem(300 * 1024 ** 2)).toBe('300 MB')
    expect(formatMem(1023 * 1024 ** 2)).toBe('1023 MB')
    expect(formatMem(1.26 * GB)).toBe('1.3 GB')
  })
  it('sorts rows by memory, skips unknown ids, reuses the card status word', () => {
    const t = (id: string, data: object) => ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: { ptyId: id, startedAt: 0, workspaceId: 'w1', ...data } }) as unknown as AppNode
    const nodes = [
      t('a', { name: 'Console 1', status: 'running' }),
      t('b', { name: 'Zoe', status: 'running', agent: { role: 'frontend', state: 'idle' } }),
      t('c', { name: 'Old', status: 'exited' }),
    ]
    const rows = usageRows(nodes, [{ id: 'w1', name: 'Workspace 1' }], [{ id: 'a', bytes: 5 }, { id: 'b', bytes: 9 }, { id: 'c', bytes: 1 }, { id: 'gone', bytes: 99 }], false)
    expect(rows.map((r) => [r.name, r.kind, r.status])).toEqual([['Zoe', 'frontend', 'resting'], ['Console 1', 'shell', 'running'], ['Old', 'shell', 'exited']])
    expect(usageRows(nodes, [], [{ id: 'b', bytes: 1 }], true)[0]!.status).toBe('paused')
  })
})

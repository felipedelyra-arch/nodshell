import { describe, expect, it } from 'vitest'
import { channels, events } from '../../src/shared/ipc/channels'

const id = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'

describe('pty channel schemas', () => {
  it('accepts valid input', () => {
    expect(channels['pty:spawn'].in.safeParse({ cols: 80, rows: 24 }).success).toBe(true)
    expect(channels['pty:write'].in.safeParse({ id, data: 'ls\r' }).success).toBe(true)
    expect(channels['pty:resize'].in.safeParse({ id, cols: 120, rows: 40 }).success).toBe(true)
    expect(channels['pty:kill'].in.safeParse({ id }).success).toBe(true)
  })

  it.each([
    ['spawn cols too small', 'pty:spawn', { cols: 1, rows: 24 }],
    ['spawn cols too large', 'pty:spawn', { cols: 501, rows: 24 }],
    ['spawn rows 0', 'pty:spawn', { cols: 80, rows: 0 }],
    ['spawn rows too large', 'pty:spawn', { cols: 80, rows: 301 }],
    ['spawn non-integer', 'pty:spawn', { cols: 80.5, rows: 24 }],
    ['write non-uuid id', 'pty:write', { id: 'nope', data: 'x' }],
    ['write data over 65536', 'pty:write', { id, data: 'x'.repeat(65537) }],
    ['write data not a string', 'pty:write', { id, data: 5 }],
    ['resize non-uuid', 'pty:resize', { id: '1', cols: 80, rows: 24 }],
    ['resize NaN', 'pty:resize', { id, cols: NaN, rows: 24 }],
    ['kill missing id', 'pty:kill', {}],
    ['ack zero bytes', 'pty:ack', { id, bytes: 0 }],
    ['ack non-uuid', 'pty:ack', { id: 'x', bytes: 5 }],
    ['ack too many bytes', 'pty:ack', { id, bytes: 100_000_001 }],
  ] as const)('rejects %s', (_n, ch, input) => {
    expect(channels[ch].in.safeParse(input).success).toBe(false)
  })

  it('accepts write data of exactly 65536', () => {
    expect(channels['pty:write'].in.safeParse({ id, data: 'x'.repeat(65536) }).success).toBe(true)
  })

  it('validates events', () => {
    expect(events['pty:data'].safeParse({ id, data: 'hi' }).success).toBe(true)
    expect(events['pty:data'].safeParse({ id: 'x', data: 'hi' }).success).toBe(false)
    expect(events['pty:exit'].safeParse({ id, code: 0 }).success).toBe(true)
    expect(events['pty:exit'].safeParse({ id, code: 'a' }).success).toBe(false)
  })
})

describe('F10 channels', () => {
  const limit = channels['settings:setLiveLimit'].in
  it('accepts a live limit from 1 to 40 only', () => {
    for (const n of [1, 20, 40]) expect(limit.safeParse({ limit: n }).success).toBe(true)
    for (const n of [0, 41, 1.5, '20', -1]) expect(limit.safeParse({ limit: n }).success).toBe(false)
  })
})

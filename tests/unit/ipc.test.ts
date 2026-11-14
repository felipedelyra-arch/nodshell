import { describe, expect, it } from 'vitest'
import { channels } from '../../src/shared/ipc/channels'
import { runValidated } from '../../src/main/ipc/validate'

const ok = () => ({ reply: 'pong', at: 1 })

describe('runValidated(ping)', () => {
  it('accepts valid input', async () => {
    await expect(runValidated(channels.ping, ok, { message: 'hi' })).resolves.toEqual({ reply: 'pong', at: 1 })
  })

  it.each([
    ['missing field', {}],
    ['wrong type', { message: 5 }],
    ['empty string', { message: '' }],
    ['over 100 chars', { message: 'x'.repeat(101) }],
    ['non-object', 'hi'],
    ['null', null],
  ])('rejects %s without echoing the payload', async (_n, raw) => {
    await expect(runValidated(channels.ping, ok, raw)).rejects.toThrow(/^Invalid request$/)
  })

  it('does not let prototype-pollution keys reach the handler', async () => {
    const raw = JSON.parse('{"message":"hi","__proto__":{"polluted":true},"constructor":{"x":1}}')
    let seen: unknown
    await runValidated(channels.ping, (i) => ((seen = i), ok()), raw)
    expect(seen).toEqual({ message: 'hi' })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('rejects a wrongly shaped handler output', async () => {
    const bad = (() => ({ reply: 1 })) as unknown as () => { reply: string; at: number }
    await expect(runValidated(channels.ping, bad, { message: 'hi' })).rejects.toThrow('Internal error')
  })
})

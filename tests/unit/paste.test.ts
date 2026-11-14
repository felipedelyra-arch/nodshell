import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptPty } from '../../src/main/domain/adapter'
import { ENTER_DELAY_MS, PASTE_END, PASTE_START, sanitizePrompt, submitBracketed } from '../../src/main/infrastructure/adapters/paste'

let n = 0
function fakePty(): PromptPty & { out: string[]; dead: boolean } {
  const p = { key: `pty-${n++}`, out: [] as string[], dead: false, write: (d: string) => void p.out.push(d), alive: () => !p.dead }
  return p
}

describe('sanitizePrompt', () => {
  it('normalizes CRLF and strips ESC, other C0, DEL and C1, keeping \\n and \\t', () => {
    expect(sanitizePrompt('a\r\nb\tc\x1b[201~d\x07\x00\x7f\x9be\rf')).toBe('a\nb\tc[201~def')
  })
  it('caps the length at 20000', () => {
    expect(sanitizePrompt('x'.repeat(25_000))).toHaveLength(20_000)
  })
})

describe('submitBracketed', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('writes the exact paste and sends Enter only after the delay', async () => {
    const pty = fakePty()
    const done = submitBracketed(pty, 'line 1\nline 2\nline 3')
    await vi.advanceTimersByTimeAsync(0)
    expect(pty.out).toEqual([`${PASTE_START}line 1\nline 2\nline 3${PASTE_END}`])
    expect(pty.out.join('')).not.toContain('\r')
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS - 1)
    expect(pty.out).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(pty.out).toEqual([`${PASTE_START}line 1\nline 2\nline 3${PASTE_END}`, '\r'])
  })

  it('an embedded end marker cannot break out of the paste', async () => {
    const pty = fakePty()
    const done = submitBracketed(pty, 'a\x1b[201~\rrm -rf ~\r\nb')
    await vi.runAllTimersAsync()
    await done
    const all = pty.out.join('')
    expect(all).toBe(`${PASTE_START}a[201~rm -rf ~\nb${PASTE_END}\r`)
    expect(all.indexOf('\r')).toBe(all.length - 1)
    expect(all.split(PASTE_END)).toHaveLength(2)
  })

  it('two concurrent prompts on one PTY never interleave', async () => {
    const pty = fakePty()
    const a = submitBracketed(pty, 'first')
    const b = submitBracketed(pty, 'second')
    await vi.runAllTimersAsync()
    await Promise.all([a, b])
    expect(pty.out).toEqual([`${PASTE_START}first${PASTE_END}`, '\r', `${PASTE_START}second${PASTE_END}`, '\r'])
  })

  it('refuses a dead PTY, and skips Enter if it dies during the delay', async () => {
    const dead = fakePty()
    dead.dead = true
    await expect(submitBracketed(dead, 'x')).rejects.toThrow('Agent is not running')
    expect(dead.out).toEqual([])

    const dying = fakePty()
    const p = submitBracketed(dying, 'x')
    const settled = p.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(0)
    dying.dead = true
    await vi.runAllTimersAsync()
    expect(await settled).toBe('Agent is not running')
    expect(dying.out).toEqual([`${PASTE_START}x${PASTE_END}`])
  })

  it('rejects a prompt that is empty after sanitizing', async () => {
    await expect(submitBracketed(fakePty(), '\x1b\x07 \n')).rejects.toThrow('Empty prompt')
  })
})

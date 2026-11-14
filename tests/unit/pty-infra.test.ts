import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateCwd } from '../../src/main/infrastructure/pty/cwd'
import { filterEnv, pickShell } from '../../src/main/infrastructure/pty/shell'

describe('validateCwd', () => {
  let base: string, root: string, outside: string
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'cwd-test-'))
    root = join(base, 'root')
    outside = join(base, 'outside')
    mkdirSync(join(root, 'inner'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(root, 'file.txt'), 'x')
    symlinkSync(outside, join(root, 'escape'))
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('accepts the root and a directory inside it', () => {
    expect(validateCwd(root, [root])).toBe(root.replace(/\/$/, ''))
    expect(validateCwd(join(root, 'inner'), [root])).toMatch(/inner$/)
  })
  it('rejects .. traversal', () => {
    expect(() => validateCwd(join(root, 'inner', '..', '..', 'outside'), [root])).toThrow()
  })
  it('rejects a symlink pointing outside the roots', () => {
    expect(() => validateCwd(join(root, 'escape'), [root])).toThrow()
  })
  it('rejects a sibling sharing the root prefix', () => {
    mkdirSync(join(base, 'root-evil'))
    expect(() => validateCwd(join(base, 'root-evil'), [root])).toThrow()
  })
  it('rejects a file and a missing path', () => {
    expect(() => validateCwd(join(root, 'file.txt'), [root])).toThrow()
    expect(() => validateCwd(join(root, 'nope'), [root])).toThrow()
  })
})

describe('pickShell', () => {
  const shells = '# comment\n/bin/sh\n/bin/bash\n/usr/bin/zsh\n'
  it('uses $SHELL when listed', () => expect(pickShell('/usr/bin/zsh', shells)).toBe('/usr/bin/zsh'))
  it('falls back when not listed, relative or missing', () => {
    expect(pickShell('/tmp/evil', shells)).toBe('/bin/bash')
    expect(pickShell('zsh', shells)).toBe('/bin/bash')
    expect(pickShell(undefined, shells)).toBe('/bin/bash')
    expect(pickShell('/usr/bin/zsh', '')).toBe('/bin/bash')
  })
  it('ignores commented entries', () => expect(pickShell('/bin/fish', '# /bin/fish\n')).toBe('/bin/bash'))
})

describe('filterEnv', () => {
  it('drops ELECTRON_*, NODE_OPTIONS and Vite/dev variables, sets TERM', () => {
    const env = filterEnv({
      HOME: '/h', PATH: '/bin', TERM: 'dumb', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://x',
      NODE_OPTIONS: '--inspect', VITE_FOO: '1', NODSHELL_USER_DATA: '/t', UNSET: undefined,
    })
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', TERM: 'xterm-256color' })
  })
})

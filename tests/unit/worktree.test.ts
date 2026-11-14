import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../src/main/domain/agent'
import { WorktreeService } from '../../src/main/infrastructure/git/worktree'
import { which } from '../../src/main/infrastructure/which'

const gitBin = which('git', process.env['PATH'])!
const git = (cwd: string, ...args: string[]) =>
  execFileSync(gitBin, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string, repoDir: string, base: string, svc: WorktreeService, repo: Repo
const branches = () => git(repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/').split('\n').filter(Boolean)

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-test-')))
  repoDir = join(tmp, 'my repo') // a space on purpose
  base = join(tmp, 'userdata', 'worktrees')
  mkdirSync(repoDir)
  git(repoDir, 'init', '-q')
  writeFileSync(join(repoDir, 'a.txt'), 'a\n')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-q', '-m', 'init')
  svc = new WorktreeService(gitBin, base)
  repo = await svc.openRepo(repoDir)
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('WorktreeService.openRepo', () => {
  it('accepts the top level and reports name and branch', () => {
    expect(repo).toEqual({ root: repoDir, name: 'my repo', branch: 'main' })
  })
  it('rejects a non-repo directory, a subdirectory and a missing path', async () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    mkdirSync(join(repoDir, 'sub'))
    await expect(svc.openRepo(plain)).rejects.toThrow('Not a git repository')
    await expect(svc.openRepo(join(repoDir, 'sub'))).rejects.toThrow('Not the top folder')
    await expect(svc.openRepo(join(tmp, 'nope'))).rejects.toThrow('Not a folder')
  })
  it('rejects a repository with no commits when adding', async () => {
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    git(empty, 'init', '-q')
    const r = await svc.openRepo(empty)
    await expect(svc.add(r, 'qa')).rejects.toThrow('The repository has no commits yet')
  })
})

describe('WorktreeService.add', () => {
  it('rejects a bad role before git is ever called', async () => {
    const marker = join(tmp, 'git-called')
    const fakeGit = join(tmp, 'fake-git')
    writeFileSync(fakeGit, `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(fakeGit, 0o755)
    const s = new WorktreeService(fakeGit, base)
    for (const role of ['../x', 'a/b', '-a', 'A', 'a b', 'x'.repeat(25)]) await expect(s.add(repo, role)).rejects.toThrow('Invalid role')
    expect(existsSync(marker)).toBe(false)
  })

  it('two agents get distinct directories and branches, outside the repo, at HEAD; n is the lowest free', async () => {
    const [a, b] = await Promise.all([svc.add(repo, 'qa'), svc.add(repo, 'qa')])
    expect(new Set([a!.path, b!.path]).size).toBe(2)
    expect([a!.branch, b!.branch].sort()).toEqual(['agent/qa-1', 'agent/qa-2'])
    for (const wt of [a!, b!]) {
      expect(wt.path.startsWith(realpathSync(base) + '/')).toBe(true)
      expect(wt.path.startsWith(repoDir)).toBe(false)
      expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(wt.branch)
      expect(wt.base).toBe(git(repoDir, 'rev-parse', 'HEAD'))
    }
    expect(await svc.remove(a!)).toBe('removed')
    const c = await svc.add(repo, 'qa')
    expect(c.branch).toBe('agent/qa-1') // freed slot is reused
    expect(await svc.remove(b!)).toBe('removed')
    expect(await svc.remove(c)).toBe('removed')
  })
})

describe('WorktreeService.remove policy', () => {
  it('clean, no commits: removes worktree, branch and the empty repo dir', async () => {
    const wt = await svc.add(repo, 'clean')
    expect(await svc.remove(wt)).toBe('removed')
    expect(existsSync(wt.path)).toBe(false)
    expect(branches()).toEqual([])
    expect(existsSync(svc.repoDir(repo.root))).toBe(false)
    expect(git(repoDir, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('clean with commits: removes the worktree, keeps the branch (archived)', async () => {
    const wt = await svc.add(repo, 'dev')
    writeFileSync(join(wt.path, 'b.txt'), 'b\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-q', '-m', 'work')
    const confirm = vi.fn()
    expect(await svc.remove(wt, confirm)).toBe('archived')
    expect(confirm).not.toHaveBeenCalled()
    expect(existsSync(wt.path)).toBe(false)
    expect(branches()).toEqual(['agent/dev-1'])
    git(repoDir, 'branch', '-D', 'agent/dev-1')
  })

  it('dirty: kept on Keep and without a confirm (quit); removed only on explicit Discard', async () => {
    const wt = await svc.add(repo, 'dirty')
    writeFileSync(join(wt.path, 'untracked.txt'), 'x\n')
    expect(await svc.remove(wt)).toBe('kept')
    const keep = vi.fn(async () => 'keep' as const)
    expect(await svc.remove(wt, keep)).toBe('kept')
    expect(keep).toHaveBeenCalledWith(wt, 0)
    expect(existsSync(join(wt.path, 'untracked.txt'))).toBe(true)
    expect(branches()).toEqual(['agent/dirty-1'])
    const failing = vi.fn(async () => {
      throw new Error('dialog failed')
    })
    expect(await svc.remove(wt, failing)).toBe('kept')
    expect(await svc.remove(wt, async () => 'discard')).toBe('removed')
    expect(existsSync(wt.path)).toBe(false)
    expect(branches()).toEqual([])
  })

  it('a tracked modification counts as dirty', async () => {
    const wt = await svc.add(repo, 'mod')
    writeFileSync(join(wt.path, 'a.txt'), 'changed\n')
    expect(await svc.remove(wt)).toBe('kept')
    expect(await svc.remove(wt, async () => 'discard')).toBe('removed')
  })
})

describe('WorktreeService.adopt (a saved worktree, checked again before a restore)', () => {
  const asSaved = (wt: { path: string; branch: string; base: string }, role: string) => ({ path: wt.path, branch: wt.branch, base: wt.base, role })

  it('accepts its own worktree, as saved', async () => {
    const wt = await svc.add(repo, 'keep')
    expect(await svc.adopt(repo, asSaved(wt, 'keep'))).toEqual(wt)
    expect(await svc.remove(wt)).toBe('removed')
  })

  it('refuses traversal, paths outside the app\'s directory for this repository, symlinks out and a missing directory', async () => {
    const wt = await svc.add(repo, 'evil')
    const s = asSaved(wt, 'evil')
    const dir = svc.repoDir(repo.root)
    await expect(svc.adopt(repo, { ...s, path: join(dir, '..', '..', '..', 'my repo') })).rejects.toThrow('its worktree is not valid')
    await expect(svc.adopt(repo, { ...s, path: `${dir}/./evil-1` })).resolves.toMatchObject({ path: wt.path }) // normalised to the very same directory
    await expect(svc.adopt(repo, { ...s, path: repoDir })).rejects.toThrow('its worktree is not valid')
    await expect(svc.adopt(repo, { ...s, path: 'relative/evil-1' })).rejects.toThrow('its worktree is not valid')
    await expect(svc.adopt(repo, { ...s, path: `${wt.path}\0` })).rejects.toThrow('its worktree is not valid')
    // a symlink named like the worktree, pointing at the repository itself
    const link = join(dir, 'evil-2')
    symlinkSync(repoDir, link)
    await expect(svc.adopt(repo, { ...s, path: link, branch: 'agent/evil-2' })).rejects.toThrow('its worktree is not valid')
    rmSync(link)
    // another repository's directory: not ours
    const other = await svc.openRepo(join(tmp, 'empty')).catch(() => null)
    if (other) await expect(svc.adopt(other, s)).rejects.toThrow()
    rmSync(wt.path, { recursive: true, force: true })
    await expect(svc.adopt(repo, s)).rejects.toThrow('its worktree is missing')
    expect(await svc.remove(wt)).toBe('removed')
  })

  it('refuses a malformed branch or base, another branch checked out, and a role that does not match', async () => {
    const wt = await svc.add(repo, 'qa')
    const s = asSaved(wt, 'qa')
    await expect(svc.adopt(repo, { ...s, branch: 'main' })).rejects.toThrow('its worktree is not valid')
    await expect(svc.adopt(repo, { ...s, branch: 'agent/qa-1; rm -rf /' })).rejects.toThrow('its worktree is not valid')
    await expect(svc.adopt(repo, { ...s, base: '--upload-pack=x' })).rejects.toThrow('its worktree is not valid')
    await expect(svc.adopt(repo, { ...s, role: 'dev' })).rejects.toThrow('its worktree is not valid')
    git(wt.path, 'checkout', '-q', '-b', 'other')
    await expect(svc.adopt(repo, s)).rejects.toThrow('its worktree is not valid')
    git(wt.path, 'checkout', '-q', 'agent/qa-1')
    git(wt.path, 'branch', '-q', '-D', 'other')
    expect(await svc.adopt(repo, s)).toEqual(wt)
    expect(await svc.remove(wt)).toBe('removed')
  })

  it('refuses a plain directory (not a worktree) where the worktree should be', async () => {
    const dir = svc.repoDir(repo.root)
    mkdirSync(join(dir, 'fake-1'), { recursive: true })
    await expect(svc.adopt(repo, { path: join(dir, 'fake-1'), branch: 'agent/fake-1', role: 'fake', base: 'a'.repeat(40) })).rejects.toThrow('its worktree is not valid')
    rmSync(join(dir, 'fake-1'), { recursive: true })
  })
})

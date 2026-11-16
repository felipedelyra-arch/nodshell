import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, sep } from 'node:path'
import { AgentError, agentName, branchName, isValidRole, lowestFreeN, slotOf, type ConfirmDiscard, type RemovalOutcome, type Repo, type Worktree } from '../../domain/agent'
import { validateCwd } from '../pty/cwd'

/** No inherited GIT_DIR/GIT_WORK_TREE redirection, never an interactive credential prompt. */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_')) out[k] = v
  out['GIT_TERMINAL_PROMPT'] = '0'
  return out
}

/** The "worktree" of an agent in a plain folder: the folder itself, no branch. Never removed. */
const PLAIN = (root: string): Worktree => ({ repoRoot: root, path: root, branch: '', base: '' })

/** One git worktree per agent, outside the repo: <baseDir>/<hash of repo real path>/<role>-<n>, branch agent/<role>-<n>. */
export class WorktreeService {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(
    private gitPath: string,
    readonly baseDir: string,
    private timeoutMs = 15_000,
  ) {}

  private git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        args,
        { cwd, env: gitEnv(process.env), timeout: this.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
  }

  /**
   * Any folder the user picked, except a subfolder of a repository and our own worktrees. A git repository with a commit gets one
   * worktree per agent; a folder without git (or without a first commit to branch from) is "plain": agents work in the folder itself.
   */
  async openRepo(dir: string): Promise<Repo> {
    let real: string
    try {
      real = realpathSync(dir)
      if (!statSync(real).isDirectory()) throw new AgentError()
    } catch {
      throw new AgentError('Not a folder')
    }
    if (existsSync(this.baseDir) && (real + sep).startsWith(realpathSync(this.baseDir) + sep)) throw new AgentError('This folder cannot be opened')
    const top = await this.git(real, ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => '')
    if (!top) return { root: real, name: basename(real), branch: 'no git', plain: true }
    if (realpathSync(top) !== real) throw new AgentError('Not the top folder of a git repository')
    const head = (await this.git(real, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim()
    if (!head) return { root: real, name: basename(real), branch: 'no commits', plain: true }
    const branch = (await this.git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
    return { root: real, name: basename(real), branch: branch || 'detached HEAD' }
  }

  repoDir(root: string): string {
    return join(this.baseDir, createHash('sha256').update(root).digest('hex').slice(0, 16))
  }

  /** Serialized so two concurrent spawns never pick the same n. */
  add(repo: Repo, role: string): Promise<Worktree> {
    if (!isValidRole(role)) return Promise.reject(new AgentError('Invalid role')) // before git is ever called
    const next = this.chain.then(() => (repo.plain ? PLAIN(repo.root) : this.doAdd(repo.root, role)))
    this.chain = next.catch(() => undefined)
    return next
  }

  private async doAdd(root: string, role: string): Promise<Worktree> {
    const base = (await this.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim()
    if (!base) throw new AgentError('The repository has no commits yet')
    const dir = this.repoDir(root)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const refs = (await this.git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/agent/'])).split('\n')
    const names = [...refs.map((r) => r.replace(/^refs\/heads\//, '')), ...readdirSync(dir)]
    const n = lowestFreeN(names.map((x) => slotOf(x, role)).filter((x) => x !== undefined))
    const branch = branchName(role, n)
    await this.git(root, ['check-ref-format', `refs/heads/${branch}`])
    const path = join(dir, agentName(role, n))
    await this.git(root, ['worktree', 'add', '-b', branch, path, base])
    return { repoRoot: root, path: validateCwd(path, [this.baseDir]), branch, base }
  }

  /**
   * A saved worktree, checked again before it is used (nothing read from the database is trusted): it must be the directory
   * <repoDir>/<role>-<n> itself (no traversal, no symlink out), exist, be a worktree of this very repository and have the
   * agent's branch `agent/<role>-<n>` checked out. Throws an AgentError saying why not.
   */
  async adopt(repo: Repo, saved: { path: string; branch: string; role: string; base: string }): Promise<Worktree> {
    if (repo.plain || (!saved.branch && !saved.base)) {
      if (repo.plain && !saved.branch && !saved.base && saved.path === repo.root) return PLAIN(repo.root)
      throw new AgentError('its worktree is not valid') // the folder gained or lost git since it was saved
    }
    const n = slotOf(saved.branch, saved.role)
    if (n === undefined || !saved.branch.startsWith('agent/') || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(saved.base)) throw new AgentError('its worktree is not valid')
    const dir = this.repoDir(repo.root)
    if (!isAbsolute(saved.path) || saved.path.includes('\0')) throw new AgentError('its worktree is not valid')
    if (!existsSync(saved.path)) throw new AgentError('its worktree is missing')
    let ok = false
    let real = ''
    try {
      real = validateCwd(saved.path, [dir])
      if (real === join(realpathSync(dir), agentName(saved.role, n))) {
        const git = (cwd: string, args: string[]) => this.git(cwd, args).then((s) => s.trim())
        const [top, mine, theirs, head] = await Promise.all([
          git(real, ['rev-parse', '--show-toplevel']),
          git(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          git(repo.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        ])
        ok = realpathSync(top) === real && realpathSync(mine) === realpathSync(theirs) && head === saved.branch
      }
    } catch {
      ok = false
    }
    if (!ok) throw new AgentError('its worktree is not valid')
    return { repoRoot: repo.root, path: real, branch: saved.branch, base: saved.base }
  }

  /**
   * Never destroys work silently:
   * clean + no commits -> remove worktree and branch; clean + commits -> remove worktree, keep branch (archived);
   * dirty -> keep everything unless `confirm` answers 'discard'. Without `confirm` (app quit) dirty work is always kept.
   * Any unexpected git failure keeps what is left.
   */
  async remove(wt: Worktree, confirm?: ConfirmDiscard): Promise<RemovalOutcome> {
    const { repoRoot: root, path, branch, base } = wt
    if (!branch) return 'removed' // plain folder: the agent worked in the project folder itself, which is never ours to remove
    try {
      const present = existsSync(path)
      if (!present) await this.git(root, ['worktree', 'prune'])
      const dirty = present && (await this.git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== ''
      const head = (await this.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')).trim()
      const commits = head ? Number((await this.git(root, ['rev-list', '--count', `${base}..${head}`])).trim()) : 0
      if (dirty) {
        if (!confirm || (await confirm(wt, commits)) !== 'discard') return 'kept'
        await this.git(root, ['worktree', 'remove', '--force', path])
        if (head) await this.git(root, ['branch', '-D', branch])
        return 'removed'
      }
      if (present) await this.git(root, ['worktree', 'remove', path])
      if (commits > 0) return 'archived'
      // compare-and-delete: only if the branch still points where we checked it
      if (head) await this.git(root, ['update-ref', '-d', `refs/heads/${branch}`, head])
      return 'removed'
    } catch {
      return existsSync(path) ? 'kept' : 'archived'
    } finally {
      try {
        rmdirSync(this.repoDir(root)) // only succeeds when empty
      } catch {
        // still has worktrees
      }
    }
  }
}

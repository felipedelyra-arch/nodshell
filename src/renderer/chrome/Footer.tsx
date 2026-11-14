import { forwardRef } from 'react'
import { liveAgentCount } from '../graph'
import { useCanvas } from '../store'

/** Bottom-left: the branch and how many live agents hold a worktree. Absent without a repository. */
export function RepoFooter() {
  const repo = useCanvas((s) => s.repo)
  const worktrees = useCanvas((s) => liveAgentCount(s.nodes))
  if (!repo) return null
  return (
    <p className="footer-chip absolute bottom-4 left-6 z-10 inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 font-mono" data-testid="repo-badge">
        <svg width="12" height="12" viewBox="0 0 12 12" role="img" aria-label="Git branch">
          <circle cx="3" cy="2.5" r="1.3" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="3" cy="9.5" r="1.3" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="9" cy="4.5" r="1.3" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <path d="M3 3.8v4.4M9 5.8c0 2-3 1.6-6 2.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span className="max-w-[200px] truncate" title={repo.branch}>
          {repo.branch}
        </span>
      </span>
      <span className="font-mono text-muted" data-testid="worktree-count" aria-label={`${worktrees} active agent worktrees`} title="Active agent worktrees">
        · {worktrees}
      </span>
    </p>
  )
}

export const BugButton = forwardRef<HTMLButtonElement, { onClick: () => void }>(function BugButton({ onClick }, ref) {
  return (
    <button ref={ref} type="button" className="footer-chip absolute bottom-4 right-6 z-10 cursor-pointer" aria-haspopup="dialog" onClick={onClick}>
      Found a bug?
    </button>
  )
})

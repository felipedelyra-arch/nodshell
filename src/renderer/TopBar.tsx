import { useEffect, useRef, useState } from 'react'
import { AboutDialog } from './chrome/InfoDialogs'
import { liveAgentCount } from './graph'
import { MAX_WORKSPACES, useCanvas } from './store'

const HOME_TIP = 'Home arrives in a later phase'

/** A top-bar chip. With `tip` it is visibly and semantically disabled and the tip says why; otherwise it runs `onClick`. */
function Chip({ id, tip, onClick, children, label, testId }: { id: string; tip?: string; onClick?: () => void; children: React.ReactNode; label?: string; testId?: string }) {
  return (
    <>
      <button type="button" className="topbar-link" data-testid={testId} aria-disabled={tip ? true : undefined} aria-label={label} aria-describedby={tip ? id : undefined} data-tip={tip} onClick={() => !tip && onClick?.()}>
        {children}
      </button>
      {tip && (
        <span id={id} className="sr-only">
          {tip}
        </span>
      )}
    </>
  )
}

const folder = (
  <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1.5 3.5a1 1 0 011-1h2.6l1.2 1.3h3.2a1 1 0 011 1v4.2a1 1 0 01-1 1h-7a1 1 0 01-1-1z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
)

/** The project chip: without a repository it opens the folder dialog; with one, a small menu (the current project, Open folder…). */
function ProjectMenu() {
  const repo = useCanvas((s) => s.repo)
  const openRepo = useCanvas((s) => s.openRepo)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
    const outside = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  const close = () => {
    setOpen(false)
    btn.current?.focus()
  }
  const onKey = (e: React.KeyboardEvent) => {
    const all = items()
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        className="topbar-link"
        data-testid="workspace"
        aria-haspopup={repo ? 'menu' : undefined}
        aria-expanded={repo ? open : undefined}
        aria-label={repo ? `Project ${repo.name}, menu` : 'Open repository'}
        onClick={() => (repo ? setOpen((v) => !v) : void openRepo())}
      >
        {folder}
        <span data-testid="workspace-name">{repo ? repo.name : 'Open repository'}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && repo && (
        <div ref={menu} role="menu" aria-label="Project" className="menu" onKeyDown={onKey}>
          <button type="button" role="menuitemradio" aria-checked="true" className="menu-item" onClick={close}>
            {folder}
            <span className="truncate">{repo.name}</span>
            <span aria-hidden="true" className="ml-auto">✓</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close()
              void openRepo()
            }}
          >
            Open folder…
          </button>
        </div>
      )}
    </div>
  )
}

/** Top-left: back to home, the project, the workspace tabs, new workspace and close. */
export function TopBar() {
  const repo = useCanvas((s) => s.repo)
  const workspaces = useCanvas((s) => s.workspaces)
  const active = useCanvas((s) => s.activeWorkspace)
  const select = useCanvas((s) => s.selectWorkspace)
  const add = useCanvas((s) => s.addWorkspace)
  const close = useCanvas((s) => s.closeWorkspace)
  const addTip = !repo ? 'Open a repository first' : workspaces.length >= MAX_WORKSPACES ? `At most ${MAX_WORKSPACES} workspaces` : undefined

  // arrows move between tabs and activate them (the active tab alone is in the tab order)
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? workspaces.length - 1 : -1
    const w = workspaces[to]
    if (!w) return
    e.preventDefault()
    select(w.id)
    document.getElementById(`tab-${w.id}`)?.focus()
  }

  return (
    <nav className="absolute left-6 top-4 z-10 flex items-center gap-2" aria-label="Workspace">
      <Chip id="home-tip" tip={HOME_TIP}>
        <span aria-hidden="true">←</span> Back to home
      </Chip>
      <ProjectMenu />
      <div role="tablist" aria-label="Workspaces" className="flex items-center gap-2">
        {workspaces.map((w, i) => (
          <button
            key={w.id}
            id={`tab-${w.id}`}
            type="button"
            role="tab"
            aria-selected={w.id === active}
            aria-controls="board"
            tabIndex={w.id === active ? 0 : -1}
            className={w.id === active ? 'tab-active' : 'topbar-link'}
            onClick={() => select(w.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {w.name}
          </button>
        ))}
      </div>
      <Chip id="new-ws-tip" tip={addTip} label="New workspace" onClick={add}>
        +
      </Chip>
      <Chip id="close-ws-tip" onClick={() => void close()} label="Close workspace">
        <span aria-hidden="true">✕</span> Close
      </Chip>
    </nav>
  )
}

/** Top-right: live count, About, and one reserved slot. */
export function TopRight() {
  const live = useCanvas((s) => liveAgentCount(s.nodes))
  const mem = useCanvas((s) => s.memoryBytes)
  const memText = mem > 0 ? `· ${(mem / 1024 ** 3).toFixed(1)} GB` : ''
  const [about, setAbout] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <div className="absolute right-6 top-4 z-10 flex items-center gap-2">
      <p className="live-badge font-mono text-[11px]" data-testid="live-badge" title={mem > 0 ? `${live} agents live. Memory of the app and all terminal processes: ${Math.round(mem / 1024 ** 2)} MB` : undefined}>
        <span className={`status-dot ${live ? 'st-idle' : 'st-exited'}`} aria-hidden="true" />
        <span aria-live="polite">{live} live</span>
        {memText && <span aria-hidden="true">{memText}</span>}
      </p>
      <button ref={btn} type="button" className="info-btn" aria-label="About" aria-haspopup="dialog" onClick={() => setAbout(true)}>
        i
      </button>
      <span className="w-7" aria-hidden="true" data-testid="top-slot" />
      {about && (
        <AboutDialog
          onClose={() => {
            setAbout(false)
            btn.current?.focus()
          }}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { PROMPT_MAX } from '../../shared/agent'
import type { ChannelOutput } from '../../shared/ipc/channels'
import { MEMORY_MAX, memoryBytes, type MemoryScope } from '../../shared/memory'
import { GLOBAL, useCommand } from '../command/store'
import { remoteMessage, useCanvas } from '../store'
import { AppDialog } from './AppDialog'
import { formatMem, usageRows, usedBytes, usedPercent, formatGB } from './memoryUsage'

type Saved = ChannelOutput<'memory:get'>
type Doc = { saved: Saved; text: string }
type Tab = MemoryScope | 'usage'
const TABS: { scope: Tab; label: string }[] = [
  { scope: 'repo', label: 'This repository' },
  { scope: 'global', label: 'Global' },
  { scope: 'usage', label: 'Usage' },
]

const size = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KiB`)
const edited = (s: Saved) => (s.updatedAt === null || s.updatedBy === null ? 'Not edited yet' : `Last edited by ${s.updatedBy} at ${new Date(s.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`)

/** Memory use per terminal and of the system, live from the 5 s report. */
function UsagePanel() {
  const memory = useCanvas((s) => s.memory)
  const nodes = useCanvas((s) => s.nodes)
  const workspaces = useCanvas((s) => s.workspaces)
  const paused = useCanvas((s) => s.paused)
  if (!memory) return <p className="text-xs text-muted">Waiting for the first reading…</p>
  const rows = usageRows(nodes, workspaces, memory.terminals, paused)
  const pct = usedPercent(memory.system)
  return (
    <>
      {memory.system && pct !== null && (
        <p className="text-xs text-text" data-testid="memory-system">
          System {formatGB(usedBytes(memory.system))} of {formatGB(memory.system.total)} GB ({pct}%)
        </p>
      )}
      <table className="usage-table" data-testid="memory-usage">
        <caption className="sr-only">Memory used by each terminal</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Memory
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid="usage-row">
              <th scope="row">{workspaces.length > 1 && r.workspace ? `${r.name} (${r.workspace})` : r.name}</th>
              <td>{r.kind}</td>
              <td>{r.status}</td>
              <td className="num">{formatMem(r.bytes)}</td>
            </tr>
          ))}
          <tr data-testid="usage-app">
            <th scope="row">NodShell</th>
            <td></td>
            <td></td>
            <td className="num">{formatMem(memory.app)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr data-testid="usage-total">
            <th scope="row">Total</th>
            <td></td>
            <td></td>
            <td className="num">{formatMem(memory.bytes)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="field-hint">An agent's memory includes the MCP servers and plugins it starts.</p>
    </>
  )
}

/** Memory: the repository's and the global markdown notes. Saving is explicit; "Copy to command bar" only fills the field, never sends. */
export function MemoryDialog({ onClose, initialTab }: { onClose: () => void; initialTab?: 'usage' }) {
  const repo = useCanvas((s) => s.repo)
  const [tab, setTab] = useState<Tab>(initialTab ?? (repo ? 'repo' : 'global'))
  const [docs, setDocs] = useState<Partial<Record<MemoryScope, Doc>>>({})
  const [changedBy, setChangedBy] = useState<Partial<Record<MemoryScope, string>>>({})
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ids = useId()
  const docsRef = useRef(docs)
  docsRef.current = docs

  const load = useCallback(async (scope: MemoryScope) => {
    try {
      const saved = await window.api.invoke('memory:get', { scope })
      setDocs((d) => ({ ...d, [scope]: { saved, text: saved.content } }))
      setChangedBy((c) => ({ ...c, [scope]: undefined }))
    } catch (e) {
      setError(remoteMessage(e, 'Could not read the memory.'))
    }
  }, [])
  useEffect(() => {
    void load('global')
    if (repo) void load('repo')
  }, [load, repo])
  // an agent wrote: a tab with no unsaved edits just reloads; edits in progress are never overwritten, the user may reload
  useEffect(
    () =>
      window.api.on('memory:changed', ({ scope, updatedBy }) => {
        const d = docsRef.current[scope]
        if (d && d.text !== d.saved.content) setChangedBy((c) => ({ ...c, [scope]: updatedBy }))
        else void load(scope)
      }),
    [load],
  )

  const dirty = (s: Tab) => {
    const d = s === 'usage' ? undefined : docs[s]
    return !!d && d.text !== d.saved.content
  }
  const tryClose = () => (dirty('global') || dirty('repo') ? setConfirming(true) : onClose())
  const usage = tab === 'usage'
  const doc = usage ? undefined : docs[tab]
  const bytes = doc ? memoryBytes(doc.text) : 0
  const over = bytes > MEMORY_MAX
  const unavailable = !usage && tab === 'repo' && !repo

  const save = async () => {
    if (usage || !doc || busy || over || !dirty(tab)) return
    setBusy(true)
    setError(null)
    try {
      const saved = await window.api.invoke('memory:save', { scope: tab, content: doc.text })
      setDocs((d) => ({ ...d, [tab as MemoryScope]: { saved, text: saved.content } }))
      setChangedBy((c) => ({ ...c, [tab as MemoryScope]: undefined }))
    } catch (e) {
      setError(remoteMessage(e, 'Could not save the memory.'))
    } finally {
      setBusy(false)
    }
  }
  const copy = () => {
    if (!doc?.text) return
    const cmd = useCommand.getState()
    const cur = cmd.text[GLOBAL] ?? ''
    const joined = cur && !/\s$/.test(cur) ? `${cur} ${doc.text}` : cur + doc.text
    if (joined.length > PROMPT_MAX) useCanvas.getState().notify(`Memory was cut to fit the command field (${PROMPT_MAX} characters).`, 'info')
    cmd.setText(GLOBAL, joined) // appended, never sent: the Enter is the user's
    tryClose()
  }
  const onTabKey = (e: KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!
    setTab(next.scope)
    document.getElementById(`${ids}-tab-${next.scope}`)?.focus()
  }

  return (
    <AppDialog label="Memory" onClose={tryClose} className="memory-modal">
      <p className="mt-2 text-xs text-muted">
        {tab === 'usage' ? 'Memory held by NodShell and by each terminal, updated every few seconds.' : 'Notes in markdown. Nothing here reaches an agent unless you send it or the agent reads it with its memory tool.'}
      </p>
      <div role="tablist" aria-label="Memory scope" className="mt-3 flex gap-2">
        {TABS.map((t, i) => (
          <button
            key={t.scope}
            id={`${ids}-tab-${t.scope}`}
            type="button"
            role="tab"
            className="memory-tab"
            aria-selected={tab === t.scope}
            aria-controls={`${ids}-panel`}
            tabIndex={tab === t.scope ? 0 : -1}
            onClick={() => setTab(t.scope)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
            {dirty(t.scope) ? ' •' : ''}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`} tabIndex={usage ? 0 : undefined} className="mt-3 flex flex-col gap-2">
        {usage ? (
          <UsagePanel />
        ) : unavailable ? (
          <p className="text-xs text-muted">Open a repository first to keep notes for it.</p>
        ) : (
          <>
            {changedBy[tab] && (
              <p role="status" className="flex items-center gap-2 text-xs text-text">
                Changed by {changedBy[tab]}.
                <button type="button" className="btn-quiet" onClick={() => void load(tab)}>
                  Reload
                </button>
              </p>
            )}
            <textarea
              className="memory-text"
              data-testid="memory-text"
              aria-label={`${TABS.find((t) => t.scope === tab)!.label} memory`}
              aria-describedby={`${ids}-size`}
              value={doc?.text ?? ''}
              disabled={!doc}
              spellCheck={false}
              onChange={(e) => {
                const text = e.target.value
                setDocs((d) => (d[tab] ? { ...d, [tab]: { ...d[tab]!, text } } : d))
              }}
            />
            <div className="flex items-center justify-between text-xs text-muted">
              <span data-testid="memory-edited">{doc ? edited(doc.saved) : 'Loading…'}</span>
              <span id={`${ids}-size`} data-testid="memory-size" className={`font-mono ${over ? 'text-danger-text' : ''}`}>
                {size(bytes)} / {MEMORY_MAX / 1024} KiB{over ? ', too long' : ''}
              </span>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger-text">
            {error}
          </p>
        )}
        {confirming ? (
          <div role="alertdialog" aria-label="Unsaved changes" className="flex items-center gap-2 text-xs text-text">
            <span>Discard unsaved changes?</span>
            <button type="button" className="btn-danger" onClick={onClose}>
              Discard
            </button>
            <button type="button" className="btn-quiet" autoFocus onClick={() => setConfirming(false)}>
              Keep editing
            </button>
          </div>
        ) : (
          !usage && (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-accent" aria-busy={busy || undefined} disabled={unavailable || !doc || over || !dirty(tab)} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn-quiet" disabled={unavailable || !doc?.text} onClick={copy}>
              Copy to command bar
            </button>
          </div>
          )
        )}
      </div>
    </AppDialog>
  )
}

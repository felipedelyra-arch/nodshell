import { useState } from 'react'
import { AppDialog } from './AppDialog'

export type RestoreChoices = { terminals: { id: string; name: string; role: string | null }[]; room: number | null; agentBytes: number }

/** Picks which saved terminals come back. Closing it opens none: agents left out stay saved and are offered again at the next start. */
export function RestoreDialog({ terminals, room, agentBytes, onDone }: RestoreChoices & { onDone: (ids: string[]) => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const agents = terminals.filter((t) => t.role !== null && picked.has(t.id)).length
  const tooMany = room !== null && agents > room
  return (
    <AppDialog label="Choose terminals to open" onClose={() => onDone([])} backdropCloses={false}>
      <p className="mt-2 text-xs text-muted">
        Tick the terminals to start. Agents you leave out stay saved with their work, group, squad and connections, and are offered again the next time this project opens.
        {room !== null && ` Each agent takes about ${(agentBytes / 2 ** 30).toFixed(1)} GB of memory: there is room for about ${room} now.`}
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-quiet" onClick={() => setPicked(new Set(terminals.map((t) => t.id)))}>
          All
        </button>
        <button type="button" className="btn-quiet" onClick={() => setPicked(new Set())}>
          None
        </button>
      </div>
      <ul className="m-0 mt-2 max-h-72 list-none overflow-y-auto p-0" data-testid="restore-list">
        {terminals.map((t) => (
          <li key={t.id}>
            <label className="restore-row flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-text hover:bg-white/5 active:bg-white/10">
              <input type="checkbox" className="accent-accent" checked={picked.has(t.id)} onChange={() => toggle(t.id)} />
              <span className="font-bold text-white">{t.name}</span>
              <span className="font-mono text-muted">{t.role ?? 'shell'}</span>
            </label>
          </li>
        ))}
      </ul>
      {tooMany && (
        <p role="status" className="text-xs text-danger-text">
          More agents than fit in memory: the ones that do not fit stay saved.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn-accent" disabled={picked.size === 0} onClick={() => onDone([...picked])}>
          Open {picked.size} selected
        </button>
        <button type="button" className="btn-quiet" onClick={() => onDone([])}>
          Open none
        </button>
      </div>
    </AppDialog>
  )
}

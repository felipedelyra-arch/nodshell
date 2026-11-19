import { useId, useMemo, useState } from 'react'
import { destinations, inWorkspace, type SourceEnd } from '../graph'
import { useCanvas } from '../store'

/** Keyboard alternative to dragging an edge: pick a destination on the same board and connect. */
export function ConnectMenu({ source, workspaceId, autoFocus }: { source: SourceEnd; workspaceId: string | undefined; autoFocus?: boolean }) {
  const nodes = useCanvas((s) => s.nodes)
  const edges = useCanvas((s) => s.edges)
  const connect = useCanvas((s) => s.connect)
  const options = useMemo(() => destinations(inWorkspace(nodes, workspaceId), source, edges), [nodes, workspaceId, source, edges])
  const [pick, setPick] = useState(0)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const chosen = options[Math.min(pick, options.length - 1)]
  return (
    <div className="flex items-center gap-2">
      <label className="field-hint m-0 shrink-0" htmlFor={id}>
        Connect to…
      </label>
      <select id={id} autoFocus={autoFocus} className="field min-w-0 flex-1 py-0.5" value={Math.min(pick, options.length - 1)} disabled={options.length === 0} onChange={(e) => setPick(Number(e.target.value))}>
        {options.length === 0 && <option value={-1}>Nothing to connect to</option>}
        {options.map((o, i) => (
          <option key={`${o.target.kind}:${o.target.id}`} value={i}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-quiet"
        aria-busy={busy || undefined}
        disabled={!chosen}
        onClick={async () => {
          if (!chosen || busy) return
          setBusy(true)
          await connect(source, chosen.target)
          setBusy(false)
          setPick(0)
        }}
      >
        Connect
      </button>
    </div>
  )
}

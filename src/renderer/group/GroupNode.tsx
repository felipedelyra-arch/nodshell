import { Handle, Position, ViewportPortal, type NodeProps } from '@xyflow/react'
import { memo, useRef, useState } from 'react'
import { ConnectMenu } from '../flow/ConnectMenu'
import { STATUS_LABEL } from '../../shared/agent'
import { membersOf, runningCount, type GroupFlowNode } from '../graph'
import { useCanvas } from '../store'

/** Invisible anchors for the squad edges (see SQUAD_HANDLES): on the frame's sides, or on the label once collapsed. Never connectable by the user. */
const handles = (collapsed: boolean) =>
  (['l', 'r'] as const).flatMap((side) =>
    (['hi', 'lo'] as const).map((h) => (
      <Handle key={side + h} id={`${side}-${h}`} type="source" position={side === 'l' ? Position.Left : Position.Right} isConnectable={false} className={`squad-handle ${collapsed ? '' : `squad-handle-${h}`}`} />
    )),
  )

export const GroupNode = memo(function GroupNode({ id, data, positionAbsoluteX, positionAbsoluteY }: NodeProps<GroupFlowNode>) {
  const running = useCanvas((s) => runningCount(s.nodes, id))
  const total = useCanvas((s) => membersOf(s.nodes, id).length)
  const connectable = useCanvas((s) => membersOf(s.nodes, id).some((m) => m.data.agent)) // a group of consoles never connects
  const toggle = useCanvas((s) => s.toggleGroup)
  const ungroup = useCanvas((s) => s.ungroup)
  const label = data.name.toUpperCase()
  const [connecting, setConnecting] = useState(false)
  const connectBtn = useRef<HTMLButtonElement>(null)
  const closeConnect = () => {
    setConnecting(false)
    connectBtn.current?.focus()
  }
  return (
    <div className="group-node h-full w-full" data-testid="group-node" data-name={data.name} data-collapsed={data.collapsed}>
      <div className="group-label">
        <span className={`status-dot ${running > 0 ? 'st-idle' : 'st-exited'}`} aria-hidden="true" />
        <span data-testid="group-label">
          <span className="group-name">{label}</span>
          <span className="group-count">{` ${total} · ${running} ${STATUS_LABEL.working}`}</span>
        </span>
        <button type="button" className="nodrag mini-icon" aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${label}`} aria-expanded={!data.collapsed} onClick={() => toggle(id, !data.collapsed)}>
          <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="nodrag mini-icon ungroup-btn" aria-label={`Ungroup ${label}`} title="Ungroup (keeps the agents running)" onClick={() => void ungroup(id)}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6" />
          </svg>
        </button>
        {connectable && (
        <button
          ref={connectBtn}
          type="button"
          className="nodrag mini-icon connect-btn"
          aria-label={`Connect ${label} to…`}
          aria-haspopup="dialog"
          aria-expanded={connecting}
          title="Connect to…"
          onClick={() => setConnecting((v) => !v)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 5h6M5.5 2.5L8 5 5.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        )}
        {data.collapsed && handles(true)}
      </div>
      {connecting && (
        // above the member cards, which are nodes of their own drawn over the group
        <ViewportPortal>
          <div
            role="dialog"
            aria-label={`Connect ${label}`}
            className="group-connect nodrag nopan"
            style={{ transform: `translate(${positionAbsoluteX + 22}px, ${positionAbsoluteY + 16}px)` }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                closeConnect()
              }
            }}
          >
            <ConnectMenu source={{ kind: 'group', id }} workspaceId={data.workspaceId} autoFocus />
          </div>
        </ViewportPortal>
      )}
      {(['l', 'r'] as const).map((side) => (
        <Handle key={side} id={side} type="source" position={side === 'l' ? Position.Left : Position.Right} isConnectable={connectable} className={connectable ? 'flow-handle' : 'squad-handle'} title={connectable ? `Drag to connect ${label}` : undefined} />
      ))}
      {!data.collapsed && handles(false)}
      {!data.collapsed && <div className="group-frame" />}
    </div>
  )
})

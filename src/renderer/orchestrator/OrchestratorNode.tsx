import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { memo, useEffect, useId, useMemo } from 'react'
import { CommandHints, CommandInput, MicButton, mentionNames } from '../command/CommandInput'
import { squadKey, useCommand, VOICE_TIP } from '../command/store'
import { statusPill } from '../../shared/agent'
import { isAlive, isGroup, isTerminal, membersOf, type OrchestratorFlowNode, type TerminalFlowNode } from '../graph'
import { useCanvas } from '../store'
import { useBusy } from '../chrome/useBusy'

const icon = { width: 13, height: 13, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
// shortcut: every agent runs Claude until other adapters exist (F9); then agentInfo should carry the adapter label
const CLI = 'Claude'

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Squad panel: the Orchestrator's status, its groups and their agents, live from the cards' state. Its terminal opens with Expand. */
export const OrchestratorNode = memo(function OrchestratorNode({ id, data, selected }: NodeProps<OrchestratorFlowNode>) {
  const nodes = useCanvas((s) => s.nodes)
  const setMaximized = useCanvas((s) => s.setMaximized)
  const maximized = useCanvas((s) => s.maximized === data.orchestratorId)
  const closeNode = useCanvas((s) => s.closeNode)
  const connectSquad = useCanvas((s) => s.connectSquad)
  const paused = useCanvas((s) => s.paused)
  const tasks = useCanvas((s) => s.tasks[id])
  const ids = useId()
  const key = squadKey(id)
  const workspaceId = data.workspaceId ?? ''
  const names = useMemo(() => mentionNames(nodes, workspaceId, id), [nodes, workspaceId, id])
  const canSend = useCommand((s) => (s.text[key] ?? '').trim() !== '' && !s.sending[key])
  const sending = useCommand((s) => s.sending[key] ?? false)
  const [connecting, runConnect] = useBusy()
  const voiceOk = useCommand((s) => s.voiceAvailable === true)
  const lead = nodes.find((n): n is TerminalFlowNode => n.id === data.orchestratorId && isTerminal(n))
  const sections = data.groups.flatMap(({ id: gid }) => {
    const g = nodes.find((n) => n.id === gid && isGroup(n))
    return g && isGroup(g) ? [{ id: gid, name: g.data.name.toUpperCase(), members: membersOf(nodes, gid) }] : []
  })
  const agents = sections.reduce((n, s) => n + s.members.length, 0)
  const updateInternals = useUpdateNodeInternals()
  // the panel's height follows its rows and the edge handles sit on its sides: re-measure them when it changes
  useEffect(() => updateInternals(id), [id, agents, sections.length, updateInternals])
  // its terminal is hidden: a question asked there (trust this folder, a permission) would otherwise wait unseen
  const asking = !maximized && lead?.data.agent && lead.data.status !== 'exited' ? lead.data.agent.state : undefined
  useEffect(() => {
    if (asking !== 'waiting' && asking !== 'starting') return
    const t = setTimeout(() => useCanvas.getState().notify('The Orchestrator is waiting for you: open its terminal (the expand button on its panel) and answer there.', 'info'), asking === 'waiting' ? 0 : 8000)
    return () => clearTimeout(t)
  }, [asking])
  if (!lead?.data.agent) return null
  const state = paused && isAlive(lead.data) ? 'paused' : lead.data.status === 'exited' ? 'exited' : lead.data.agent.state
  // the state is only told by the header dot (as in the reference) and by the expand button's name: "needs you" or "starting" mean answer it in the terminal
  const label = statusPill(state).label
  const expand = () => setMaximized(maximized ? null : data.orchestratorId)
  const done = tasks?.done ?? 0
  const total = tasks?.total ?? 0
  const taskTip = tasks?.recent.length ? ['Latest tasks', ...tasks.recent.map((t) => `${t.status} · ${t.assignee} · ${t.title}`)].join('\n') : 'No tasks yet'

  return (
    <div className={`orch-node ${selected ? 'is-selected' : ''}`} data-testid="orchestrator-node" data-state={state}>
      {(['l', 'r'] as const).flatMap((side) =>
        (['hi', 'lo'] as const).map((h) => (
          <Handle key={side + h} id={`${side}-${h}`} type="target" position={side === 'l' ? Position.Left : Position.Right} isConnectable={false} className={`squad-handle squad-handle-${h}`} />
        )),
      )}
      {/* the end of a user's edge: never the start (the Orchestrator's own terminal is not a source on the board) */}
      {(['l', 'r'] as const).map((side) => (
        <Handle key={side} id={side} type="target" position={side === 'l' ? Position.Left : Position.Right} isConnectableStart={false} className="flow-handle" />
      ))}
      <div className="drag-handle orch-head cursor-grab">
        <span className={`status-dot shrink-0 st-${state}`} role="img" aria-label={`Orchestrator ${label}`} title={label} data-testid="orch-dot" />
        <span className="orch-title">Orchestrator</span>
        <span className="orch-mono ml-auto" data-testid="orch-tasks" aria-label={`${done} of ${total} tasks done`} title={taskTip}>
          {done}/{total}
        </span>
        <button type="button" className="icon-btn icon-btn-close nodrag" aria-label="Close Orchestrator" onClick={() => void closeNode(data.orchestratorId)}>
          <svg {...icon} strokeWidth={1.5}>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      <div className="orch-summary">
        <span data-testid="orch-summary">
          {agents} agents · {sections.length} groups
        </span>
        <button type="button" className="orch-connect nodrag" title="Connect the groups to the Orchestrator" aria-busy={connecting || undefined} onClick={() => void runConnect(() => connectSquad(id))}>
          Connect
        </button>
      </div>
      <div className="orch-list nowheel">
        {sections.map((s) => (
          <section key={s.id} aria-label={s.name} data-testid="orch-section">
            <h3 className="orch-sec">
              <span data-testid="orch-section-name">{s.name}</span>
              <span className="orch-mono">{s.members.length}</span>
            </h3>
            <ul className="m-0 list-none p-0">
              {s.members.map((m) => {
                const p = statusPill(paused && isAlive(m.data) ? 'paused' : m.data.status === 'exited' ? 'exited' : (m.data.agent?.state ?? 'running'))
                return (
                  <li key={m.id} className="orch-row" data-testid="orch-row" data-name={m.data.name}>
                    <span className="orch-avatar" aria-hidden="true">
                      {m.data.name.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="orch-name">{m.data.name}</span>
                      <span className="orch-sub">
                        {capitalize(m.data.agent?.role ?? 'shell')} · {CLI}
                      </span>
                    </span>
                    <span className={`status-pill ${p.active ? 'status-pill-on' : ''}`} data-testid="orch-row-status">
                      {p.label}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      <CommandHints fieldKey={key} workspaceId={workspaceId} squadId={id} className="orch-hints" />
      <div className="orch-foot">
        <CommandInput fieldKey={key} scope={() => ({ workspaceId, squadId: id })} names={names} placeholder={`Command ${agents} agents · @ to direct…`} label="Command the squad" wrapClass="orch-field" />
        <span id={`${ids}-cmd`} className="sr-only">
          {VOICE_TIP}
        </span>
        <button type="button" className="icon-btn nodrag" aria-label={`Open Orchestrator terminal (${label})`} aria-pressed={maximized} title="Open the Orchestrator terminal (Esc restores)" onClick={expand}>
          <svg {...icon}>
            <path d="M1.5 4.5v-3h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" />
          </svg>
        </button>
        <button type="button" className="icon-btn nodrag" aria-label="Send command" aria-busy={sending || undefined} aria-disabled={!canSend || undefined} onClick={() => canSend && void useCommand.getState().send(key, { workspaceId, squadId: id })}>
          <svg {...icon}>
            <path d="M6 10V2M2.5 5.5L6 2l3.5 3.5" />
          </svg>
        </button>
        <MicButton fieldKey={key} className="icon-btn nodrag" tipId={voiceOk ? undefined : `${ids}-cmd`}>
          <svg {...icon}>
            <rect x="4.2" y="1.2" width="3.6" height="6" rx="1.8" />
            <path d="M2.5 5.8a3.5 3.5 0 007 0M6 9.3v1.5" />
          </svg>
        </MicButton>
      </div>
    </div>
  )
})

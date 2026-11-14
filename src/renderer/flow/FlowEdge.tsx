import { EdgeLabelRenderer, getBezierPath, ViewportPortal, type EdgeProps } from '@xyflow/react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { CONDITION_MAX, TEMPLATE_MAX } from '../../shared/flow'
import { CONTROL_RE } from '../../shared/preset'
import type { FlowFlowEdge } from '../graph'
import { useCanvas } from '../store'

/**
 * A flow edge: a thin orange bezier with a small dot at its middle. The dot is a button that opens the edge's editor.
 * While the edge fires its stroke runs (stroke-dashoffset, off with reduced motion); paused, it is dimmed and dashed.
 */
const LANE_PX = 16 // the second edge of a two-way pair runs this much lower, so both paths and dots stay apart

export const FlowEdge = memo(function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowFlowEdge>) {
  const dy = data?.lane ? LANE_PX : 0
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY: sourceY + dy, sourcePosition, targetX, targetY: targetY + dy, targetPosition })
  const [open, setOpen] = useState(false)
  const dot = useRef<HTMLButtonElement>(null)
  if (!data) return null
  const state = data.paused ? 'paused' : data.firing ? 'firing' : 'active'
  return (
    <>
      <path d={path} className={`flow-edge is-${state} ${data.lit ? 'is-lit' : ''}`} data-testid="flow-edge" data-state={state} data-lit={data.lit || undefined} />
      <EdgeLabelRenderer>
        <button
          ref={dot}
          type="button"
          className={`flow-dot nodrag nopan is-${state}`}
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
          aria-label={`Edge ${data.label}${data.paused ? ', paused' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`Edge ${data.label}`}
          data-testid="flow-edge-dot"
          onClick={() => setOpen((v) => !v)}
        />
      </EdgeLabelRenderer>
      {open && (
        <ViewportPortal>
          <EdgeEditor
            data={data}
            at={{ x: midX, y: midY }}
            onClose={() => {
              setOpen(false)
              dot.current?.focus()
            }}
          />
        </ViewportPortal>
      )}
    </>
  )
})

function EdgeEditor({ data, at, onClose }: { data: NonNullable<FlowFlowEdge['data']>; at: { x: number; y: number }; onClose: () => void }) {
  const { edge } = data
  const update = useCanvas((s) => s.updateEdge)
  const remove = useCanvas((s) => s.removeEdge)
  const flowsPaused = useCanvas((s) => s.flowsPaused)
  const [template, setTemplate] = useState(edge.template)
  const [condition, setCondition] = useState(edge.condition)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const ids = useId()
  useEffect(() => area.current?.focus(), [])
  const validTemplate = template.trim().length > 0 && !template.includes('\0')
  const validCondition = !CONTROL_RE.test(condition)
  const dirty = template !== edge.template || condition !== edge.condition
  const run = async (fn: () => Promise<boolean>, close: boolean) => {
    if (busy) return
    setBusy(true)
    const ok = await fn()
    setBusy(false)
    if (ok && close) onClose()
  }
  const status = edge.paused ? `Paused · ${edge.paused}` : flowsPaused ? 'Active · every flow is paused, use Resume all' : 'Active'

  return (
    <div
      role="dialog"
      aria-label={`Edge ${data.label}`}
      className="edge-editor nodrag nopan nowheel"
      style={{ transform: `translate(-50%, 14px) translate(${at.x}px, ${at.y}px)` }}
      data-testid="edge-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <p className="edge-editor-title">{data.label}</p>
      <label className="field-label" htmlFor={`${ids}-tpl`}>
        Template
      </label>
      <textarea
        ref={area}
        id={`${ids}-tpl`}
        className="field resize-none font-mono text-[11px]"
        rows={3}
        maxLength={TEMPLATE_MAX}
        value={template}
        aria-invalid={!validTemplate}
        aria-describedby={`${ids}-tpl-hint`}
        onChange={(e) => setTemplate(e.target.value)}
      />
      <p id={`${ids}-tpl-hint`} className="field-hint">
        {'{message}'} is the last reply; {'{name}'}, {'{role}'} and {'{group}'} are of its agent.
      </p>
      <label className="field-label" htmlFor={`${ids}-cond`}>
        Only when the reply contains
      </label>
      <input id={`${ids}-cond`} className="field" maxLength={CONDITION_MAX} value={condition} placeholder="Always" autoComplete="off" spellCheck={false} aria-invalid={!validCondition} onChange={(e) => setCondition(e.target.value)} />
      <p className={`field-hint ${edge.paused ? 'field-hint-error' : ''}`} data-testid="edge-status" role="status">
        {status}
      </p>
      {edge.note && (
        <p className="field-hint field-hint-error" data-testid="edge-note">
          Last run · {edge.note}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn-danger" disabled={busy} onClick={() => void run(() => remove(edge.id), true)}>
          Remove
        </button>
        <button type="button" className="btn-quiet ml-auto" disabled={busy} onClick={() => void run(() => update(edge.id, { paused: !edge.paused }), false)}>
          {edge.paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="btn-accent" disabled={busy || !dirty || !validTemplate || !validCondition} onClick={() => void run(() => update(edge.id, { template, condition }), true)}>
          Save
        </button>
      </div>
    </div>
  )
}

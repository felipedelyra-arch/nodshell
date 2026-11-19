import { EdgeLabelRenderer, getBezierPath, useStore, ViewportPortal, type EdgeProps } from '@xyflow/react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { CONDITION_MAX, TEMPLATE_MAX } from '../../shared/flow'
import { CONTROL_RE } from '../../shared/preset'
import type { FlowFlowEdge } from '../graph'
import { useCanvas } from '../store'
import { activityWords, runnerPath } from './activity'
import { useMotion } from './motion'
import { ConfirmRow } from '../chrome/ConfirmRow'

/**
 * A flow edge: a thin dashed orange bezier with a small dot at its middle. The dot is a button that opens the edge's editor.
 * A few dots run along it to show its state (see edgeActivity). They move by transform and opacity only, on the compositor: the path
 * is sampled once into Web Animations keyframes, and again only once its geometry settles after a change (never per frame, not on zoom).
 */
const LANE_PX = 16 // the second edge of a two-way pair runs this much lower, so both paths and dots stay apart
const RUNNERS = 3
const SAMPLES = 32
const SLOW_PX_S = 30 // flow pixels per second at the slow speed; fast is FAST times that
const FAST = 3
// The dots move in steps of STEP_MS (about 15 a second at the slow speed): a frame where nothing moved draws nothing. Measured with 8
// edges in software rendering, against a 60 fps glide: renderer +5 instead of +11 points, GPU process +3 instead of +13; at 2 px a
// step the eye still reads a glide. Every dot steps on one grid of the document timeline (see snap), so all edges change together.
const STEP_MS = 64
const snap = (a: Animation) =>
  void a.ready.then(() => {
    if (a.startTime !== null && a.playState === 'running') a.startTime = Math.round(Number(a.startTime) / STEP_MS) * STEP_MS
  }, () => undefined) // cancelled meanwhile
const SETTLE_MS = 150 // a drag or resize moves the path every frame: the dots come back once it has stood still this long
const RUNNER_MIN_ZOOM = 0.3 // below this the dots would be about a pixel: none

export const FlowEdge = memo(function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowFlowEdge>) {
  const dy = data?.lane ? LANE_PX : 0
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY: sourceY + dy, sourcePosition, targetX, targetY: targetY + dy, targetPosition })
  const [open, setOpen] = useState(false)
  const dot = useRef<HTMLButtonElement>(null)
  const line = useRef<SVGPathElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const anims = useRef<Animation[]>([])
  const inView = useRef(true)
  const motion = useMotion()
  const far = useStore((s) => s.transform[2] < RUNNER_MIN_ZOOM)
  const act = data?.activity
  const reverse = act?.direction === 'toGroup'
  const run = act !== undefined && act.speed !== 'stopped' && motion === 'on'
  const rate = act?.speed === 'fast' ? FAST : 1
  const still = motion === 'reduced' || far
  const apply = useRef(() => {})
  apply.current = () => {
    for (const a of anims.current) {
      if (!run || !inView.current) a.pause()
      else if (a.playbackRate !== rate || a.playState !== 'running') {
        a.playbackRate = rate
        a.play()
        snap(a)
      }
    }
  }
  useEffect(() => {
    const el = host.current
    const p = line.current
    if (!el || !p || still) return
    const t = setTimeout(() => {
      const len = p.getTotalLength()
      if (len < 1) return
      const { box, frames } = runnerPath(Array.from({ length: SAMPLES + 1 }, (_, i) => p.getPointAtLength((len * i) / SAMPLES)), reverse)
      Object.assign(el.style, { transform: `translate(${box.x}px, ${box.y}px)`, width: `${box.w}px`, height: `${box.h}px` })
      el.hidden = false
      const steps = Math.max(RUNNERS, Math.round((len / SLOW_PX_S) * (1000 / STEP_MS)))
      anims.current = [...el.children].map((c, i) =>
        c.animate(frames, { duration: steps * STEP_MS, iterations: Infinity, easing: `steps(${steps})`, delay: -Math.round((steps * i) / RUNNERS) * STEP_MS }),
      )
      anims.current.forEach(snap)
      apply.current()
    }, SETTLE_MS)
    return () => {
      clearTimeout(t)
      for (const a of anims.current) a.cancel()
      anims.current = []
      el.hidden = true
    }
  }, [path, reverse, still])
  useEffect(() => apply.current(), [run, rate])
  // nobody sees an edge outside the window: its dots wait
  useEffect(() => {
    const el = host.current
    if (!el) return
    const io = new IntersectionObserver((es) => {
      inView.current = es.at(-1)?.isIntersecting ?? true
      apply.current()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  if (!data || !act) return null
  const state = data.paused ? 'paused' : data.firing ? 'firing' : 'active'
  const name = `Edge ${data.label}, ${activityWords(act)}`
  return (
    <>
      <path
        ref={line}
        d={path}
        className={`flow-edge is-${state} tone-${act.tone} ${data.lit ? 'is-lit' : ''}`}
        data-testid="flow-edge"
        data-state={state}
        data-direction={act.direction}
        data-speed={act.speed}
        data-tone={act.tone}
        data-lit={data.lit || undefined}
      />
      <EdgeLabelRenderer>
        <div ref={host} className={`flow-runners tone-${act.tone}`} hidden aria-hidden="true" data-testid="flow-runners">
          {Array.from({ length: RUNNERS }, (_, i) => (
            <span key={i} className="flow-runner" />
          ))}
        </div>
        <button
          ref={dot}
          type="button"
          className={`flow-dot nodrag nopan is-${state} tone-${act.tone} ${data.lane ? 'is-lane' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
          aria-label={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={name}
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
  const [confirming, setConfirming] = useState(false)
  const removeBtn = useRef<HTMLButtonElement>(null)
  const keep = () => {
    setConfirming(false)
    requestAnimationFrame(() => removeBtn.current?.focus()) // the Remove button is back after this render
  }
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
          if (confirming) keep()
          else onClose()
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
      {confirming ? (
        <ConfirmRow className="mt-2" label="Remove connection" confirm="Remove" busy={busy} onKeep={keep} onConfirm={() => void run(() => remove(edge.id), true)}>
          Remove this connection? Its template and condition are lost.
        </ConfirmRow>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button ref={removeBtn} type="button" className="btn-danger" disabled={busy} onClick={() => setConfirming(true)}>
            Remove
          </button>
          <button type="button" className="btn-quiet ml-auto" disabled={busy} onClick={() => void run(() => update(edge.id, { paused: !edge.paused }), false)}>
            {edge.paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn-accent" aria-busy={busy || undefined} disabled={!dirty || !validTemplate || !validCondition} onClick={() => void run(() => update(edge.id, { template, condition }), true)}>
            Save
          </button>
        </div>
      )}
    </div>
  )
}

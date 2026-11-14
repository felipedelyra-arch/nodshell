import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { MODEL_CHOICES, PROMPT_MAX, SQUAD_SIZE, type ModelChoice } from '../../shared/agent'
import { PRESET_NAME_MAX, validatePreset, type PresetErrors, type PresetFields } from '../../shared/preset'
import { useCanvas } from '../store'
import { usePresets, type PresetDto } from './store'

const EMPTY: PresetFields = { name: '', role: '', model: null, systemPrompt: '' }
const FOCUSABLE = 'button:not([disabled]), input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'

const toFields = (p: PresetDto): PresetFields => ({ name: p.name, role: p.role, model: p.model, systemPrompt: p.systemPrompt })

export function PresetsDialog({ onClose }: { onClose: () => void }) {
  const presets = usePresets((s) => s.presets)
  const save = usePresets((s) => s.save)
  const remove = usePresets((s) => s.remove)
  const [selected, setSelected] = useState<string | null>(null) // null = a new preset
  const [fields, setFields] = useState<PresetFields>(EMPTY)
  const [touched, setTouched] = useState<Set<keyof PresetFields>>(new Set())
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const repo = useCanvas((s) => s.repo)
  const createSquad = useCanvas((s) => s.createSquad)
  const [squadState, setSquadState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const root = useRef<HTMLDivElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const deleteBtn = useRef<HTMLButtonElement>(null)
  const ids = useId()
  const current = presets.find((p) => p.id === selected)
  const result = validatePreset(fields)
  const errors: PresetErrors = result.ok ? {} : result.errors
  const shown = (k: keyof PresetFields) => (submitted || touched.has(k) ? errors[k] : undefined)

  useEffect(() => nameInput.current?.focus(), [])

  const choose = (p: PresetDto | null) => {
    setSelected(p?.id ?? null)
    setFields(p ? toFields(p) : EMPTY)
    setTouched(new Set())
    setSubmitted(false)
    setServerError(null)
    setConfirming(false)
    nameInput.current?.focus()
  }
  const edit = (patch: Partial<PresetFields>) => {
    setFields((f) => ({ ...f, ...patch }))
    setTouched((t) => new Set([...t, ...(Object.keys(patch) as (keyof PresetFields)[])]))
    setServerError(null)
  }

  const onSave = async () => {
    setSubmitted(true)
    if (!result.ok || busy) return
    setBusy(true)
    const err = await save({ id: selected ?? undefined, ...result.value })
    setBusy(false)
    if (err) return setServerError(err)
    if (selected === null) {
      const made = usePresets.getState().presets.find((p) => p.name.toLowerCase() === result.value.name.toLowerCase())
      if (made) choose(made)
    } else setFields(result.value)
  }

  const onDelete = async () => {
    if (!current || busy) return
    setBusy(true)
    const err = await remove(current.id)
    setBusy(false)
    if (err) return setServerError(err)
    choose(null)
  }

  const restoring = useCanvas((s) => s.restoring)
  const squadTip = !repo ? 'Open a repository first' : restoring ? 'Wait for the board to finish restoring' : undefined
  const onSquad = async () => {
    if (squadTip || squadState.busy) return
    setSquadState({ busy: true, error: null })
    const error = await createSquad()
    setSquadState({ busy: false, error })
    if (!error) onClose()
  }

  const cancelConfirm = () => {
    setConfirming(false)
    requestAnimationFrame(() => deleteBtn.current?.focus()) // the Delete button is back after this render
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (confirming) cancelConfirm()
      else onClose()
      return
    }
    if (e.key !== 'Tab' || !root.current) return
    // focus trap
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    const outside = !root.current.contains(active)
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={root} role="dialog" aria-modal="true" aria-label="Presets" className="modal" onKeyDown={onKeyDown}>
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm text-text">Presets</h2>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[190px_1fr] gap-4">
          <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Preset list">
            {presets.map((p) => (
              <li key={p.id}>
                <button type="button" className="preset-item" aria-current={p.id === selected} onClick={() => choose(p)}>
                  <span className="truncate">{p.name}</span>
                  {p.builtin && <span className="text-[9px] text-muted">built-in</span>}
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="preset-item" aria-current={selected === null} onClick={() => choose(null)}>
                + New preset
              </button>
            </li>
          </ul>
          <section aria-labelledby={`${ids}-layouts`}>
            <h3 id={`${ids}-layouts`} className="field-label m-0 mb-1">
              Layouts
            </h3>
            <ul className="m-0 list-none p-0" aria-label="Layouts">
              <li>
                <button
                  type="button"
                  className="preset-item flex-col !items-start"
                  aria-disabled={squadTip || squadState.busy ? true : undefined}
                  aria-busy={squadState.busy || undefined}
                  aria-describedby={`${ids}-squad-desc${squadTip ? ` ${ids}-squad-tip` : ''}`}
                  data-tip={squadTip}
                  onClick={() => void onSquad()}
                >
                  <span>Squad</span>
                  <span id={`${ids}-squad-desc`} className="text-[9px] text-muted">
                    {squadState.busy ? `Starting ${SQUAD_SIZE} agents…` : 'Orchestrator + 4 groups of 2'}
                  </span>
                </button>
                {squadTip && (
                  <span id={`${ids}-squad-tip`} className="sr-only">
                    {squadTip}
                  </span>
                )}
              </li>
            </ul>
            {squadState.error && (
              <p role="alert" className="field-hint field-hint-error" data-testid="layout-error">
                {squadState.error}
              </p>
            )}
          </section>
          </div>
          <form
            className="flex min-h-0 flex-col overflow-auto pr-1"
            noValidate
            aria-label={current ? `Edit ${current.name}` : 'New preset'}
            onSubmit={(e) => {
              e.preventDefault()
              void onSave()
            }}
          >
            <label className="field-label" htmlFor={`${ids}-name`}>
              Name
            </label>
            <input
              ref={nameInput}
              id={`${ids}-name`}
              className="field"
              value={fields.name}
              maxLength={PRESET_NAME_MAX + 20}
              autoComplete="off"
              aria-invalid={!!shown('name')}
              aria-describedby={`${ids}-name-hint`}
              onChange={(e) => edit({ name: e.target.value })}
            />
            <p id={`${ids}-name-hint`} className={`field-hint ${shown('name') ? 'field-hint-error' : ''}`}>
              {shown('name') ?? `Shown on the group label, up to ${PRESET_NAME_MAX} characters.`}
            </p>
            <label className="field-label" htmlFor={`${ids}-role`}>
              Role
            </label>
            <input
              id={`${ids}-role`}
              className="field"
              value={fields.role}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              placeholder="e.g. frontend"
              aria-invalid={!!shown('role')}
              aria-describedby={`${ids}-role-hint`}
              onChange={(e) => edit({ role: e.target.value })}
            />
            <p id={`${ids}-role-hint`} className={`field-hint ${shown('role') ? 'field-hint-error' : ''}`}>
              {shown('role') ?? 'Agents are named <role>-<n>, on branch agent/<role>-<n>.'}
            </p>
            <label className="field-label" htmlFor={`${ids}-model`}>
              Model
            </label>
            <select id={`${ids}-model`} className="field" value={fields.model ?? ''} onChange={(e) => edit({ model: e.target.value === '' ? null : (e.target.value as ModelChoice) })}>
              <option value="">default</option>
              {MODEL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor={`${ids}-prompt`}>
              System prompt
            </label>
            <textarea
              id={`${ids}-prompt`}
              className="field min-h-28 resize-y"
              value={fields.systemPrompt}
              rows={6}
              aria-invalid={!!shown('systemPrompt')}
              aria-describedby={`${ids}-prompt-hint`}
              onChange={(e) => edit({ systemPrompt: e.target.value })}
            />
            <p id={`${ids}-prompt-hint`} className={`field-hint ${shown('systemPrompt') ? 'field-hint-error' : ''}`}>
              {shown('systemPrompt') ?? `${fields.systemPrompt.length} / ${PROMPT_MAX}`}
            </p>
            {serverError && (
              <p role="alert" className="field-hint field-hint-error mt-2">
                {serverError}
              </p>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              {current && !current.builtin && !confirming && (
                <button ref={deleteBtn} type="button" className="btn-quiet mr-auto" onClick={() => setConfirming(true)}>
                  Delete
                </button>
              )}
              {confirming && current && (
                <div className="mr-auto flex items-center gap-2" role="group" aria-label="Confirm delete">
                  <span className="text-[11px] text-text">Delete “{current.name}”?</span>
                  <button type="button" className="btn-quiet" autoFocus onClick={cancelConfirm}>
                    Keep
                  </button>
                  <button type="button" className="btn-danger" onClick={() => void onDelete()}>
                    Confirm delete
                  </button>
                </div>
              )}
              <button type="submit" className="btn-accent" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

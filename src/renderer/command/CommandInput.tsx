import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { PROMPT_MAX } from '../../shared/agent'
import { isGroup, isOrchestrator, isTerminal, membersOf, type AppNode } from '../graph'
import { describePreview, statusSegment, type Preview } from './hints'
import { micLevel, useCommand, VOICE_TIP, type Scope } from './store'

/** Names `@` can reach in a scope: agents first, then groups (what main will accept; main still decides). */
export function mentionNames(nodes: AppNode[], workspaceId: string, squadId?: string): string[] {
  const inWs = nodes.filter((n) => n.data.workspaceId === workspaceId)
  const squad = squadId === undefined ? undefined : inWs.find((n) => isOrchestrator(n) && n.id === squadId)
  if (squadId !== undefined && !(squad && isOrchestrator(squad))) return []
  const groupIds = squad && isOrchestrator(squad) ? new Set(squad.data.groups.map((g) => g.id)) : null
  const groups = inWs.filter((n) => isGroup(n) && (!groupIds || groupIds.has(n.id)))
  const lead = squad && isOrchestrator(squad) ? inWs.filter((n) => n.id === squad.data.orchestratorId) : []
  const agents = groupIds ? [...lead, ...groups.flatMap((g) => membersOf(inWs, g.id))] : inWs.filter(isTerminal)
  return [...new Set([...agents.flatMap((a) => (isTerminal(a) && a.data.agent ? [a.data.name] : [])), ...groups.map((g) => (isGroup(g) ? g.data.name : ''))].filter(Boolean))]
}

/** The `@` being completed, if any: the text is only "@" and a partial name. */
const completing = (text: string): string | null => (/^@[^\n]*$/.test(text) ? text.slice(1).trimStart() : null)

export type CommandInputProps = {
  fieldKey: string
  scope: () => Scope
  names: string[]
  placeholder: string
  label: string
  wrapClass: string
}

/** One-line command field: Enter sends, `@` suggests names, ArrowUp on an empty field walks the history. */
export function CommandInput({ fieldKey, scope, names, placeholder, label, wrapClass }: CommandInputProps) {
  const text = useCommand((s) => s.text[fieldKey] ?? '')
  const voice = useCommand((s) => s.voice)
  const tick = useCommand((s) => s.focusTick[fieldKey] ?? 0)
  const ref = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const walk = useRef(-1) // position in the history while walking it with ArrowUp/ArrowDown
  const query = completing(text)
  const options = useMemo(() => (query === null ? [] : names.filter((n) => n.toLowerCase().startsWith(query.toLowerCase()))), [names, query])
  const open = !dismissed && options.length > 0
  const set = useCommand.getState().setText

  useEffect(() => {
    if (tick === 0) return
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [tick])

  const pick = (name: string) => {
    set(fieldKey, `@${name} `)
    setDismissed(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && e.repeat) return e.preventDefault() // a send needs a fresh keydown, never a held key
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return pick(options[Math.min(active, options.length - 1)] ?? '')
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return setDismissed(true)
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      return void useCommand.getState().send(fieldKey, scope())
    }
    const history = useCommand.getState().history
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (text === '' || walk.current >= 0)) {
      e.preventDefault()
      const next = Math.max(-1, Math.min(history.length - 1, walk.current + (e.key === 'ArrowUp' ? 1 : -1)))
      walk.current = next
      set(fieldKey, history[next] ?? '')
    }
  }

  const busy = voice.target === fieldKey && voice.status !== 'idle'
  return (
    <label className={wrapClass}>
      <input
        ref={ref}
        data-command-key={fieldKey}
        className="nodrag nopan"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        aria-label={label}
        aria-describedby={text.trim() ? targetId(fieldKey) : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={PROMPT_MAX}
        placeholder={busy ? (voice.status === 'listening' ? 'Speak now…' : 'Your words appear here…') : placeholder} // the state itself is told once, by the status next to the field
        value={text}
        onChange={(e) => {
          walk.current = -1
          setDismissed(false)
          setActive(0)
          useCommand.getState().setNote(fieldKey) // typing dismisses the dictation result or error
          set(fieldKey, e.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Agents and groups" className="cmd-suggest nodrag nopan nowheel">
          {options.map((n, i) => (
            <li key={n} id={`${listId}-${i}`} role="option" aria-selected={i === Math.min(active, options.length - 1)} onMouseDown={(e) => (e.preventDefault(), pick(n))}>
              @{n}
            </li>
          ))}
        </ul>
      )}
    </label>
  )
}

const targetId = (fieldKey: string) => `cmd-target-${fieldKey}`

/** Input level while recording: scaled by an animation frame loop that exists only while this is mounted (recording); a still mark with reduced motion. */
function LevelMeter() {
  const bar = useRef<HTMLElement>(null)
  const still = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  useEffect(() => {
    if (still) return
    let raf = 0
    const tick = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0.06, micLevel())})`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [still])
  return still ? (
    <span className="cmd-rec" data-testid="rec-mark" aria-hidden="true" />
  ) : (
    <span className="cmd-meter" data-testid="level-meter" aria-hidden="true">
      <i ref={bar} />
    </span>
  )
}

/** What a field tells the user: the dictation state (a status line) and, while it has text, who the command would reach (asked of main, which decides; advisory). */
export function CommandHints({ fieldKey, workspaceId, squadId, className }: { fieldKey: string; workspaceId: string; squadId?: string; className: string }) {
  const text = useCommand((s) => s.text[fieldKey] ?? '')
  const voice = useCommand((s) => s.voice)
  const note = useCommand((s) => s.notes[fieldKey])
  const seg = statusSegment(voice.target === fieldKey ? voice.status : 'idle', note, Date.now())
  const [preview, setPreview] = useState<Preview | null>(null)
  const q = text.trim()
  const landed = note?.kind === 'ready' && note.fieldText === text // a dictation just put this text here: ask at once
  useEffect(() => {
    if (!q || /^@\S*$/.test(q)) return setPreview(null) // empty, or still completing a name
    let live = true // a late answer for older text is dropped
    const t = setTimeout(
      () =>
        window.api.invoke('command:preview', { text: q, workspaceId, ...(squadId ? { squadId } : {}) }).then(
          (p) => live && setPreview(p),
          () => live && setPreview(null),
        ),
      landed ? 0 : 150,
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, workspaceId, squadId, landed])
  const d = q && preview ? describePreview(preview) : null
  return (
    <div className={className}>
      <span role="status" className={`cmd-status ${seg?.kind === 'error' ? 'is-error' : ''}`} data-kind={seg?.kind}>
        {seg?.kind === 'listening' && <LevelMeter />}
        {seg?.text}
      </span>
      {d && (d.ok || d.err) && (
        <span id={targetId(fieldKey)} className="cmd-target" data-testid="command-target">
          {d.ok}
          {d.ok && d.err ? ' · ' : ''}
          {d.err && <span className="is-error">{d.err}</span>}
        </span>
      )}
    </div>
  )
}

/** Microphone: hold to talk (release stops), or tap to start and tap again to stop. Never sends. */
export function MicButton({ fieldKey, className, children, tipId }: { fieldKey: string; className: string; children: React.ReactNode; tipId?: string }) {
  const available = useCommand((s) => s.voiceAvailable)
  const voice = useCommand((s) => s.voice)
  const mine = voice.target === fieldKey
  const { voiceDown, voiceUp, voiceAbort } = useCommand.getState()
  useEffect(() => () => voiceAbort(`mic:${fieldKey}`), [voiceAbort, fieldKey]) // a recording never outlives its button
  const down = () => voiceDown(`mic:${fieldKey}`, fieldKey, true)
  const up = () => voiceUp(`mic:${fieldKey}`)
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    down()
  }
  const isKey = (e: KeyboardEvent) => e.key === ' ' || e.key === 'Enter'
  const ok = available === true
  return (
    <button
      type="button"
      className={`${className} ${mine && voice.status === 'listening' ? 'is-listening' : ''}`}
      aria-label={mine && voice.status === 'listening' ? 'Stop dictation' : 'Dictate command'}
      aria-pressed={mine && voice.status === 'listening'}
      aria-disabled={ok ? undefined : true}
      aria-describedby={ok ? undefined : tipId}
      data-tip={ok ? undefined : VOICE_TIP}
      onPointerDown={onPointerDown}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      data-command-key={fieldKey}
      onKeyDown={(e) => {
        if (!isKey(e)) return
        e.preventDefault()
        if (!e.repeat) down()
      }}
      onKeyUp={(e) => {
        if (!isKey(e)) return
        e.preventDefault()
        up()
      }}
    >
      {children}
      {mine && voice.status === 'listening' && <span className="listen-ring" aria-hidden="true" />}
    </button>
  )
}

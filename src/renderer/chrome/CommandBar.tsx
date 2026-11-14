import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CommandInput, MicButton, mentionNames } from '../command/CommandInput'
import { GLOBAL, HOLD_MS, useCommand, VOICE_TIP } from '../command/store'
import { useCanvas } from '../store'
import { KEEPS_KEYS } from '../board/focus'

const icon = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** Hold Space with the focus on the board (never in a terminal, field or control): records while held. */
function useSpaceToSpeak() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let held = false
    const release = () => {
      clearTimeout(timer)
      timer = undefined
      if (held) void useCommand.getState().endVoice()
      held = false
    }
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest(KEEPS_KEYS) || document.querySelector('[aria-modal=true], dialog[open]')) return
      if (useCommand.getState().voiceAvailable !== true) return
      e.preventDefault() // not the page scroll
      if (e.repeat || timer || held) return
      timer = setTimeout(() => {
        timer = undefined
        held = true
        void useCommand.getState().beginVoice(GLOBAL).then((started) => !started && (held = false))
      }, HOLD_MS)
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && release()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release) // the store ends the recording itself; this clears the pending hold
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
    }
  }, [])
}

/** The global command bar: text and dictation go to the main process, which decides who receives them. */
export function CommandBar() {
  const tipId = useId()
  const histId = useId()
  const nodes = useCanvas((s) => s.nodes)
  const workspaceId = useCanvas((s) => s.activeWorkspace)
  const names = useMemo(() => mentionNames(nodes, workspaceId), [nodes, workspaceId])
  const text = useCommand((s) => s.text[GLOBAL] ?? '')
  const sending = useCommand((s) => s.sending[GLOBAL] ?? false)
  const history = useCommand((s) => s.history)
  const available = useCommand((s) => s.voiceAvailable)
  const [open, setOpen] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLUListElement>(null)
  const chevron = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [open])
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      chevron.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[to]?.focus()
    } else if (e.key === 'Tab') setOpen(false)
  }
  useEffect(() => void useCommand.getState().loadVoice(), [])
  useSpaceToSpeak()
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => !bar.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const canSend = text.trim() !== '' && !sending
  const scope = () => ({ workspaceId: useCanvas.getState().activeWorkspace })
  const noHistory = history.length === 0

  return (
    <div ref={bar} className="cmd-bar pointer-events-auto" role="group" aria-label="Command bar">
      <svg className="cmd-logo" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <defs>
          <radialGradient id={`${tipId}-g`} cx="35%" cy="30%" r="80%">
            <stop offset="0" stopColor="#ffb27a" />
            <stop offset="1" stopColor="#e2561a" />
          </radialGradient>
        </defs>
        <circle cx="14" cy="14" r="13" fill={`url(#${tipId}-g)`} />
        <path d="M9 11.5h10M9 16.5h6" stroke="#2a1206" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <CommandInput fieldKey={GLOBAL} scope={scope} names={names} placeholder="Hold space to speak · @ to direct…" label="Command" wrapClass="cmd-field" />
      <span id={tipId} className="sr-only">
        {VOICE_TIP}
      </span>
      <div className="relative">
        <button
          ref={chevron}
          type="button"
          className="cmd-btn"
          aria-label="Show history"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-disabled={noHistory || undefined}
          data-tip={noHistory ? 'No commands yet' : undefined}
          onClick={() => !noHistory && setOpen(!open)}
        >
          <svg {...icon}>
            <path d="M3.5 10.5L8 6l4.5 4.5" />
          </svg>
        </button>
        {open && !noHistory && (
          <ul ref={menu} id={histId} role="menu" aria-label="Recent commands" className="cmd-history" onKeyDown={onMenuKey}>
            {history.map((h) => (
              <li key={h} role="none">
                <button
                  type="button"
                  role="menuitem"
                  title={h}
                  onClick={() => {
                    useCommand.getState().setText(GLOBAL, h)
                    useCommand.setState((s) => ({ focusTick: { ...s.focusTick, [GLOBAL]: (s.focusTick[GLOBAL] ?? 0) + 1 } }))
                    setOpen(false)
                  }}
                >
                  {h}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="cmd-btn cmd-send" aria-label="Send" aria-disabled={!canSend || undefined} onClick={() => canSend && void useCommand.getState().send(GLOBAL, scope())}>
        <svg {...icon}>
          <path d="M8 12.5v-9M4 7.5l4-4 4 4" />
        </svg>
      </button>
      <MicButton fieldKey={GLOBAL} className="cmd-btn" tipId={available === true ? undefined : tipId}>
        <svg {...icon}>
          <path d="M8 2.5a2 2 0 00-2 2v3.5a2 2 0 004 0V4.5a2 2 0 00-2-2zM4 7.5a4 4 0 008 0M8 11.5v2" />
        </svg>
      </MicButton>
    </div>
  )
}

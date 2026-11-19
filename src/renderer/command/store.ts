import { create } from 'zustand'
import { PROMPT_MAX } from '../../shared/agent'
import { HOLD_MS, SAMPLE_RATE } from '../../shared/voice'
import { remoteMessage, useCanvas } from '../store'
import { createPtt } from './ptt'
import { READY_MS, type Note } from './hints'
import { startRecorder, type Recorder } from './recorder'

export const HISTORY_MAX = 20
/** A recording with less audio than a hold is dropped. */
const MIN_BYTES = (SAMPLE_RATE * 2 * HOLD_MS) / 1000
export const VOICE_TIP = 'Voice needs whisper.cpp in ~/.local/share/whisper.cpp'
/** Where a command goes: the whole workspace, or one squad's Orchestrator field. */
export type Scope = { workspaceId: string; squadId?: string }
export const GLOBAL = 'global'
export const squadKey = (squadId: string) => `squad:${squadId}`

type VoiceState = { status: 'idle' | 'listening' | 'transcribing'; target: string | null }
type State = {
  /** the text of each command field, by key */
  text: Record<string, string>
  /** the last commands sent from this window, newest first */
  history: string[]
  sending: Record<string, boolean>
  /** bumped to make a field take focus with the cursor at the end */
  focusTick: Record<string, number>
  voice: VoiceState
  /** what stays visible next to a field after a dictation, by key: cleared by typing, sending or the next dictation */
  notes: Record<string, Note>
  setNote: (key: string, note?: Note) => void
  /** null until main answers */
  voiceAvailable: boolean | null
  setText: (key: string, text: string) => void
  send: (key: string, scope: Scope) => Promise<void>
  loadVoice: () => Promise<void>
  /** a push-to-talk source went down or up: `src` is 'space' or `mic:<field>`; a microphone button also toggles (tap to start, tap to stop) */
  voiceDown: (src: string, key: string, toggle?: boolean) => void
  voiceUp: (src: string) => void
  voiceBlur: () => void
  /** the control `src` is gone: ends its recording, if it has one, without transcribing */
  voiceAbort: (src: string) => void
}

// the recorder lives outside the state: it is a handle on the microphone, not data
let cur: Promise<Recorder> | null = null
let target = 'global' // the field of the recording in progress
let rec: Recorder | null = null // the open recording, for the level meter
/** Smoothed input level (0..1) of the recording in progress; read by the meter's animation frame loop, never through React state. */
export const micLevel = (): number => rec?.level() ?? 0

/** The focus is on the board, nowhere, or on the command controls: dictation may pull it back to the field. Never from a terminal or another control. */
const focusIsFree = (): boolean => {
  const a = document.activeElement
  // a microphone button keeps the focus: moving it to the field would turn the next Enter on the button into a send
  return !a || a === document.body || a.matches('.react-flow, .react-flow__pane, .react-flow__viewport, .react-flow__renderer') || (a.closest('[data-command-key]') !== null && a.tagName !== 'BUTTON')
}

export const useCommand = create<State>((set, get) => {
  const bump = (key: string) => set((s) => ({ focusTick: { ...s.focusTick, [key]: (s.focusTick[key] ?? 0) + 1 } }))
  const idle = () => set({ voice: { status: 'idle', target: null } })
  // the toast goes away; the note stays next to the field until the next dictation or typing
  const notify = (text: string, tone: 'error' | 'info', key = target) => {
    useCanvas.getState().notify(text, tone)
    get().setNote(key, { kind: 'error', text })
  }
  const ptt = createPtt({
    // opens the microphone and buffers from the press itself, not after HOLD_MS
    open: () => {
      const mine = startRecorder(() => ptt.send({ t: 'limit' }), () => ptt.send({ t: 'lost' }))
      cur = mine
      mine.then(
        (r) => void (cur === mine && (rec = r)),
        () => cur === mine && ptt.send({ t: 'failed' }),
      )
    },
    show: () => set({ voice: { status: 'listening', target } }),
    discard: () => {
      idle() // an abort can come while "listening" is already shown
      const r = cur
      cur = null
      rec = null
      void r?.then((x) => x.abort(), () => undefined)
    },
    lost: () => notify('The microphone was disconnected.', 'error'),
    fail: () => {
      cur = null
      rec = null
      idle()
      notify('Could not open the microphone.', 'error')
    },
    finish: async () => {
      const to = target
      const r = cur
      cur = null
      rec = null
      set({ voice: { status: 'transcribing', target: to } })
      try {
        const opened = await r?.catch(() => undefined)
        if (!opened) return void notify('Could not open the microphone.', 'error', to)
        const pcm = await opened.finish()
        if (pcm.byteLength < MIN_BYTES) return void notify("Didn't catch that.", 'info', to)
        const { text } = await window.api.invoke('voice:transcribe', { pcm })
        if (!text) return void notify("Didn't catch that.", 'info', to)
        // dictation only types: appended to the field, never sent
        const old = get().text[to] ?? ''
        get().setText(to, old && !/\s$/.test(old) ? `${old} ${text}` : old + text)
        const note: Note = { kind: 'ready', fieldText: get().text[to] ?? '', until: Date.now() + READY_MS }
        get().setNote(to, note)
        setTimeout(() => get().notes[to] === note && get().setNote(to), READY_MS)
        if (focusIsFree()) bump(to) // otherwise the user went to type elsewhere: only the text is added
      } catch (e) {
        notify(remoteMessage(e, 'Could not transcribe.'), 'error', to)
      } finally {
        idle()
      }
    },
  })
  return {
    text: {},
    history: [],
    sending: {},
    focusTick: {},
    voice: { status: 'idle', target: null },
    notes: {},
    setNote: (key, note) => set((s) => (note || s.notes[key] ? { notes: note ? { ...s.notes, [key]: note } : Object.fromEntries(Object.entries(s.notes).filter(([k]) => k !== key)) } : s)),
    voiceAvailable: null,
    setText: (key, text) => set((s) => ({ text: { ...s.text, [key]: text.slice(0, PROMPT_MAX) } })),

    send: async (key, scope) => {
      const text = (get().text[key] ?? '').trim()
      if (!text || get().sending[key]) return
      get().setNote(key)
      set((s) => ({ sending: { ...s.sending, [key]: true } }))
      try {
        const r = await window.api.invoke('command:send', { text, workspaceId: scope.workspaceId, ...(scope.squadId ? { squadId: scope.squadId } : {}) })
        if (r.delivered.length > 0) {
          // only what went somewhere is cleared; a command nobody took stays in the field to be fixed
          set((s) => ({ history: [text, ...s.history.filter((h) => h !== text)].slice(0, HISTORY_MAX), text: { ...s.text, [key]: s.text[key]?.trim() === text ? '' : (s.text[key] ?? '') } }))
        }
        if (r.refused.length > 0) notify(r.refused.map((x) => `${x.name} ${x.reason}`).join(' · '), 'error')
      } catch (e) {
        notify(remoteMessage(e, 'Could not send the command.'), 'error')
      } finally {
        set((s) => ({ sending: { ...s.sending, [key]: false } }))
        bump(key)
      }
    },

    loadVoice: async () => {
      try {
        set({ voiceAvailable: (await window.api.invoke('voice:status', undefined)).available })
      } catch {
        set({ voiceAvailable: false })
      }
    },

    voiceDown: (src, key, toggle) => {
      if (get().voiceAvailable !== true) return
      if (ptt.phase() === 'idle') {
        target = key
        get().setNote(key) // a new dictation clears the last result
      }
      ptt.send({ t: 'down', src, toggle })
    },
    voiceUp: (src) => ptt.send({ t: 'up', src }),
    voiceBlur: () => ptt.send({ t: 'blur' }),
    voiceAbort: (src) => ptt.send({ t: 'abort', src }),
  }
})

// the microphone must never stay open behind the user's back: leaving the window ends any recording, whatever started it
const stopListening = () => useCommand.getState().voiceBlur()
if (typeof window !== 'undefined') {
  window.addEventListener('blur', stopListening)
  document.addEventListener('visibilitychange', () => document.hidden && stopListening())
}

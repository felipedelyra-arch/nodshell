import { create } from 'zustand'
import { PROMPT_MAX } from '../../shared/agent'
import { SAMPLE_RATE } from '../../shared/voice'
import { remoteMessage, useCanvas } from '../store'
import { startRecorder, type Recorder } from './recorder'

export const HISTORY_MAX = 20
/** Holding Space or the microphone shorter than this is a tap, not a recording; a recording with less audio than this is dropped. */
export const HOLD_MS = 250
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
  /** null until main answers */
  voiceAvailable: boolean | null
  setText: (key: string, text: string) => void
  send: (key: string, scope: Scope) => Promise<void>
  loadVoice: () => Promise<void>
  beginVoice: (key: string) => Promise<boolean>
  endVoice: () => Promise<void>
  /** microphone button pressed / released (mouse or keyboard): hold to talk, or tap to start and tap to stop */
  micDown: (key: string) => void
  micUp: (key: string) => void
}

// the recorder lives outside the state: it is a handle on the microphone, not data
let rec: Recorder | null = null
let stopAsked = false // released before the microphone was ready
// the press in progress on a microphone button; it belongs to one recording, so another button's release never ends it
let press: { key: string; downAt: number; stopOnUp: boolean } | null = null

/** The focus is on the board, nowhere, or on the command controls: dictation may pull it back to the field. Never from a terminal or another control. */
const focusIsFree = (): boolean => {
  const a = document.activeElement
  return !a || a === document.body || a.matches('.react-flow, .react-flow__pane, .react-flow__viewport, .react-flow__renderer') || a.closest('[data-command-key]') !== null
}

export const useCommand = create<State>((set, get) => {
  const bump = (key: string) => set((s) => ({ focusTick: { ...s.focusTick, [key]: (s.focusTick[key] ?? 0) + 1 } }))
  const idle = () => set({ voice: { status: 'idle', target: null } })
  const notify = (text: string, tone: 'error' | 'info') => useCanvas.getState().notify(text, tone)
  return {
    text: {},
    history: [],
    sending: {},
    focusTick: {},
    voice: { status: 'idle', target: null },
    voiceAvailable: null,
    setText: (key, text) => set((s) => ({ text: { ...s.text, [key]: text.slice(0, PROMPT_MAX) } })),

    send: async (key, scope) => {
      const text = (get().text[key] ?? '').trim()
      if (!text || get().sending[key]) return
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

    // the caller is a user gesture (held Space, microphone button); false when it did not start
    beginVoice: async (key) => {
      if (get().voiceAvailable !== true || get().voice.status !== 'idle') return false
      set({ voice: { status: 'listening', target: key } })
      stopAsked = false
      try {
        rec = await startRecorder(() => void get().endVoice())
      } catch {
        idle()
        notify('Could not open the microphone.', 'error')
        return false
      }
      if (stopAsked) void get().endVoice()
      return true
    },

    endVoice: async () => {
      const { status, target } = get().voice
      if (status !== 'listening' || !target) return
      if (!rec) {
        stopAsked = true
        return
      }
      const r = rec
      rec = null
      set({ voice: { status: 'transcribing', target } })
      try {
        const pcm = await r.stop()
        if (pcm.byteLength < MIN_BYTES) return void notify("Didn't catch that.", 'info')
        const { text } = await window.api.invoke('voice:transcribe', { pcm })
        if (!text) return void notify("Didn't catch that.", 'info')
        // dictation only types: appended to the field, never sent
        const cur = get().text[target] ?? ''
        get().setText(target, cur && !/\s$/.test(cur) ? `${cur} ${text}` : cur + text)
        if (focusIsFree()) bump(target) // otherwise the user went to type elsewhere: only the text is added
      } catch (e) {
        notify(remoteMessage(e, 'Could not transcribe.'), 'error')
      } finally {
        idle()
      }
    },

    micDown: (key) => {
      const st = get()
      if (st.voiceAvailable !== true) return
      if (st.voice.status === 'listening' && st.voice.target === key) press = { key, downAt: Date.now(), stopOnUp: true }
      else if (st.voice.status === 'idle') {
        press = { key, downAt: Date.now(), stopOnUp: false }
        void st.beginVoice(key)
      }
    },

    micUp: (key) => {
      const p = press
      if (!p || p.key !== key) return
      press = null
      if (p.stopOnUp || Date.now() - p.downAt >= HOLD_MS) void get().endVoice()
    },
  }
})

// the microphone must never stay open behind the user's back: leaving the window ends any recording, whatever started it
const stopListening = () => {
  press = null
  if (useCommand.getState().voice.status === 'listening') void useCommand.getState().endVoice()
}
if (typeof window !== 'undefined') {
  window.addEventListener('blur', stopListening)
  document.addEventListener('visibilitychange', () => document.hidden && stopListening())
}

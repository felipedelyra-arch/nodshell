// Pure helpers for what the command fields tell the user: input level, dictation status, and who a command will reach.

/** Root mean square of one audio block, 0..1. */
export function blockRms(block: ArrayLike<number>): number {
  if (block.length === 0) return 0
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += (block[i] ?? 0) ** 2
  return Math.sqrt(sum / block.length)
}

/** Smoothed meter value, 0..1: rises fast, falls slowly. Speech sits around 0.02-0.2 RMS, so it is scaled up. */
export function smoothLevel(prev: number, rms: number): number {
  const target = Math.min(1, rms * 5)
  return target > prev ? prev + (target - prev) * 0.6 : prev * 0.92
}

export const READY_MS = 4000
export const READY_TEXT = 'Dictated. Press Enter to send.'
/** What stays visible next to a field after a dictation: it landed (`ready`, with the field text it left and when it expires) or failed (`error`, until the next dictation or typing). */
export type Note = { kind: 'ready'; fieldText: string; until: number } | { kind: 'error'; text: string }
export type Segment = { kind: 'listening' | 'transcribing' | 'ready' | 'error'; text: string }

/** The one status line of a field, or null. Recording (including the tail) and transcribing win over any note. */
export function statusSegment(voice: 'idle' | 'listening' | 'transcribing', note: Note | undefined, now: number): Segment | null {
  if (voice === 'listening') return { kind: 'listening', text: 'Listening…' }
  if (voice === 'transcribing') return { kind: 'transcribing', text: 'Transcribing…' }
  if (!note) return null
  if (note.kind === 'error') return { kind: 'error', text: note.text }
  return now < note.until ? { kind: 'ready', text: READY_TEXT } : null
}

export type Preview = { targets: { name: string }[]; refused: { name: string; reason: string }[]; group?: string | undefined }
const SHOWN = 3

/** "→ Zoe", "→ Orchestrator +1", "→ FRONTEND · Mia, Ray +2"; `err` is what would be refused. */
export function describePreview(p: Preview): { ok: string; err: string } {
  const names = p.targets.map((t) => t.name)
  let ok = ''
  if (names.length > 0) {
    const same = names.every((n) => n === names[0])
    const shown = same ? names.slice(0, 1) : names.slice(0, SHOWN)
    const more = names.length - shown.length
    ok = `→ ${p.group ? `${p.group.toUpperCase()} · ` : ''}${shown.join(', ')}${more > 0 ? ` +${more}` : ''}`
  }
  return { ok, err: p.refused.map((r) => `${r.name} ${r.reason}`).join(' · ') }
}

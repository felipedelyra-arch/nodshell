// Zod-free voice limits shared by main (IPC schema, STT) and the renderer (recorder).
export const SAMPLE_RATE = 16_000
/** Longest recording, in seconds. */
export const VOICE_MAX_SECONDS = 60
/** 16-bit mono PCM of the longest recording. */
export const PCM_MAX_BYTES = VOICE_MAX_SECONDS * SAMPLE_RATE * 2
/** Holding Space or the microphone shorter than this is a tap, not a recording; the "listening" state shows only after it. */
export const HOLD_MS = 250
/** Capture goes on this long after the key or button is released, so the end of the last word is not cut. */
export const TAIL_MS = 300

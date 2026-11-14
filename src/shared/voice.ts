// Zod-free voice limits shared by main (IPC schema, STT) and the renderer (recorder).
export const SAMPLE_RATE = 16_000
/** Longest recording, in seconds. */
export const VOICE_MAX_SECONDS = 60
/** 16-bit mono PCM of the longest recording. */
export const PCM_MAX_BYTES = VOICE_MAX_SECONDS * SAMPLE_RATE * 2

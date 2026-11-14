import { SAMPLE_RATE } from '../../../shared/voice'
/** Speech to text, pluggable: whisper.cpp today; a cloud provider only has to implement this (its key would live in main). */
export interface SttProvider {
  available(): boolean
  /** `pcm`: 16 kHz mono signed 16-bit little-endian samples. Resolves to the text, '' when nothing was understood. */
  transcribe(pcm: Uint8Array): Promise<string>
}

export { PCM_MAX_BYTES } from '../../../shared/voice'

/** A WAV file (RIFF, PCM, 16 kHz, mono, 16 bit) around the samples, in memory only. */
export function wavFromPcm(pcm: Uint8Array): Buffer {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + pcm.byteLength, 4)
  head.write('WAVEfmt ', 8, 'ascii')
  head.writeUInt32LE(16, 16) // fmt chunk size
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(SAMPLE_RATE, 24)
  head.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  head.writeUInt16LE(2, 32) // block align
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([head, pcm])
}

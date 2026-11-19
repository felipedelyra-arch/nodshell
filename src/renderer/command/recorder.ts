import { PCM_MAX_BYTES, SAMPLE_RATE } from '../../shared/voice'
import { blockRms, smoothLevel } from './hints'

export type Recorder = { finish(): Promise<Uint8Array<ArrayBuffer>>; abort(): void; /** smoothed input level, 0..1 */ level(): number }
const DRAIN_TIMEOUT_MS = 250

/**
 * Opens the microphone and collects 16 kHz mono 16-bit PCM in memory only. Call it from a user gesture. `finish()` drains the worklet
 * and returns the audio; `abort()` drops it; both end the tracks. At the 60 s limit it calls `onLimit`; if the device goes away, `onLost`.
 */
export async function startRecorder(onLimit: () => void, onLost: () => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  let ctx: AudioContext | undefined
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE }) // the browser resamples the microphone to this rate
    await ctx.audioWorklet.addModule('./pcm-worklet.js')
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfOutputs: 0 })
    const pcm = new Uint8Array(PCM_MAX_BYTES)
    const view = new DataView(pcm.buffer)
    let bytes = 0
    let drained: (() => void) | undefined
    let lvl = 0
    node.port.onmessage = (e: MessageEvent<Float32Array | 'done'>) => {
      if (e.data === 'done') return drained?.()
      lvl = smoothLevel(lvl, blockRms(e.data))
      for (const f of e.data) {
        if (bytes >= PCM_MAX_BYTES) return
        view.setInt16(bytes, Math.round(Math.max(-1, Math.min(1, f)) * 32767), true)
        bytes += 2
      }
      if (bytes >= PCM_MAX_BYTES) onLimit()
    }
    source.connect(node)
    const track = stream.getAudioTracks()[0]
    if (track) track.onended = onLost
    const audio = ctx
    const close = async () => {
      if (track) track.onended = null
      node.port.onmessage = null
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      await audio.close().catch(() => undefined)
    }
    return {
      level: () => lvl,
      abort: () => void close(),
      finish: async () => {
        // blocks still in transit arrive before the worklet's marker; the timeout covers a dead worklet
        await new Promise<void>((done) => {
          drained = done
          setTimeout(done, DRAIN_TIMEOUT_MS)
          node.port.postMessage('flush')
        })
        await close()
        return pcm.slice(0, bytes)
      },
    }
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    await ctx?.close().catch(() => undefined)
    throw e
  }
}

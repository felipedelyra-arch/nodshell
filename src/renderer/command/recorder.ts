import { PCM_MAX_BYTES, SAMPLE_RATE } from '../../shared/voice'

export type Recorder = { stop(): Promise<Uint8Array<ArrayBuffer>> }

/**
 * Opens the microphone and collects 16 kHz mono 16-bit PCM in memory only. Call it from a user gesture; `stop()` always ends the
 * tracks. At the 60 s limit it calls `onLimit` (the caller then stops and transcribes what there is).
 */
export async function startRecorder(onLimit: () => void): Promise<Recorder> {
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
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      for (const f of e.data) {
        if (bytes >= PCM_MAX_BYTES) return
        view.setInt16(bytes, Math.round(Math.max(-1, Math.min(1, f)) * 32767), true)
        bytes += 2
      }
      if (bytes >= PCM_MAX_BYTES) onLimit()
    }
    source.connect(node)
    const audio = ctx
    return {
      stop: async () => {
        node.port.onmessage = null
        source.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        await audio.close().catch(() => undefined)
        return pcm.slice(0, bytes)
      },
    }
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    await ctx?.close().catch(() => undefined)
    throw e
  }
}

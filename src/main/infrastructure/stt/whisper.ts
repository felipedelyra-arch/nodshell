import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentError } from '../../domain/agent'
import { PCM_MAX_BYTES, wavFromPcm, type SttProvider } from './provider'

export type WhisperOptions = { bin: string; model: string; timeoutMs?: number; maxOutput?: number }
const OUT_MAX = 8_000
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** The paths of the installed whisper.cpp, or the ones in AGENT_CANVAS_WHISPER_BIN / AGENT_CANVAS_WHISPER_MODEL. */
export function whisperFromEnv(env: NodeJS.ProcessEnv = process.env): WhisperCppProvider {
  const base = join(homedir(), '.local', 'share', 'whisper.cpp')
  return new WhisperCppProvider({ bin: env['AGENT_CANVAS_WHISPER_BIN'] || join(base, 'src', 'build', 'bin', 'whisper-cli'), model: env['AGENT_CANVAS_WHISPER_MODEL'] || join(base, 'models', 'ggml-base.bin') })
}

/** Runs `whisper-cli` once per request (argv array, no shell): the WAV goes to its stdin and the text comes back on stdout; nothing touches the disk. */
export class WhisperCppProvider implements SttProvider {
  private busy = false
  private cancel: (() => void) | null = null
  constructor(private o: WhisperOptions) {}

  /** Kills a transcription in progress (the app is quitting or its window is gone). */
  abort(): void {
    this.cancel?.()
  }

  available(): boolean {
    return isFile(this.o.bin) && isFile(this.o.model)
  }

  async transcribe(pcm: Uint8Array): Promise<string> {
    if (pcm.byteLength === 0 || pcm.byteLength > PCM_MAX_BYTES || pcm.byteLength % 2 !== 0) throw new AgentError('Invalid audio')
    if (!this.available()) throw new AgentError('Voice needs whisper.cpp in ~/.local/share/whisper.cpp')
    if (this.busy) throw new AgentError('Still transcribing the previous recording')
    this.busy = true
    try {
      return await this.run(wavFromPcm(pcm))
    } finally {
      this.busy = false
    }
  }

  private run(wav: Buffer): Promise<string> {
    const max = this.o.maxOutput ?? OUT_MAX
    return new Promise((resolve, reject) => {
      // with `-f -` whisper.cpp prints nothing unless the output name is not "-" (and with "-" it opens /dev/stdout, which fails on the socket Node gives it); no -o* flag is set, so `-of /dev/null` writes no file
      const child = spawn(this.o.bin, ['-m', this.o.model, '-f', '-', '-nt', '-np', '-l', 'auto', '-of', '/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env['PATH'] ?? '' } })
      let out = ''
      let done = false
      const end = (err: Error | null, text = '') => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.cancel = null
        if (child.exitCode === null) child.kill('SIGKILL')
        return err ? reject(err) : resolve(text)
      }
      this.cancel = () => end(new AgentError('Transcription cancelled'))
      const timer = setTimeout(() => end(new AgentError('Transcription took too long')), this.o.timeoutMs ?? 60_000)
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
        if (out.length > max * 4) end(new AgentError('Transcription was too long'))
      })
      child.on('error', () => end(new AgentError('Could not run whisper.cpp')))
      child.on('close', (code) => (code === 0 ? end(null, clean(out, max)) : end(new AgentError('Transcription failed'))))
      child.stdin.on('error', () => undefined) // it may exit before reading everything; 'close' tells how it went
      child.stdin.end(wav)
    })
  }
}

/** One line of plain text: no control characters, no whisper markers like [BLANK_AUDIO], capped. */
export function clean(raw: string, max = OUT_MAX): string {
  return raw.replace(CONTROL, ' ').replace(/\[[A-Z_ ]{3,}\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

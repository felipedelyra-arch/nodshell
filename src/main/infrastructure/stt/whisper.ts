import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { join } from 'node:path'
import { AgentError } from '../../domain/agent'
import { PCM_MAX_BYTES, wavFromPcm, type SttProvider } from './provider'

export type WhisperOptions = { bin: string; model: string; timeoutMs?: number; maxOutput?: number; lang?: string; threads?: number; vocabulary?: string }
export const DEFAULT_VOCABULARY = 'Conversa técnica sobre Claude, Claude Code, Supabase, Next.js, Vercel, Firebase, Flutter, TypeScript, worktree, commit, branch, deploy, pull request, Orchestrator, frontend e backend.'
const PROMPT_MAX = 600
const NAME_MAX = 40

/** 4 threads is the default of whisper.cpp and slow; leave 4 cores to the terminals, at most 8 (more does not help the base model). */
export const whisperThreads = (cores: number): number => Math.min(8, Math.max(4, cores - 4))

/** `auto` or a 2-letter lowercase code; anything else is pt. */
export const whisperLang = (v: string | undefined): string => (v !== undefined && /^(auto|[a-z]{2})$/.test(v) ? v : 'pt')

const plain = (t: string): string => t.replace(/[^\p{L}\p{N} .,'-]/gu, ' ').replace(/\s+/g, ' ').trim()

/** The initial prompt: vocabulary + names, plain text only (it becomes an argv element). Leading dashes are stripped so it can never read as an option; '' means no prompt. */
export function buildPrompt(vocabulary: string, names: readonly string[] = []): string {
  const ns = [...new Set(names.filter((n) => n.length <= NAME_MAX).map(plain).filter(Boolean))].slice(0, 40)
  const all = [plain(vocabulary), ns.length ? `Nomes: ${ns.join(', ')}.` : ''].filter(Boolean).join(' ')
  return all.replace(/^[-\s]+/, '').slice(0, PROMPT_MAX).trim()
}

/** The whole argv of one run; `--prompt` is omitted when there is nothing to say. */
export function whisperArgs(o: { model: string; lang: string; threads: number; prompt: string }): string[] {
  // with `-f -` whisper.cpp prints nothing unless the output name is not "-" (and with "-" it opens /dev/stdout, which fails on the socket Node gives it); no -o* flag is set, so `-of /dev/null` writes no file
  return ['-m', o.model, '-f', '-', '-nt', '-np', '-l', o.lang, '-t', String(o.threads), ...(o.prompt ? ['--prompt', o.prompt] : []), '-of', '/dev/null']
}
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

/** The paths of the installed whisper.cpp, or the ones in NODSHELL_WHISPER_BIN / NODSHELL_WHISPER_MODEL. */
export function whisperFromEnv(env: NodeJS.ProcessEnv = process.env): WhisperCppProvider {
  const base = join(homedir(), '.local', 'share', 'whisper.cpp')
  return new WhisperCppProvider({ bin: env['NODSHELL_WHISPER_BIN'] || join(base, 'src', 'build', 'bin', 'whisper-cli'), model: env['NODSHELL_WHISPER_MODEL'] || join(base, 'models', 'ggml-base.bin'), lang: whisperLang(env['NODSHELL_WHISPER_LANG']), threads: whisperThreads(availableParallelism()), vocabulary: env['NODSHELL_WHISPER_PROMPT'] || DEFAULT_VOCABULARY })
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

  async transcribe(pcm: Uint8Array, opts?: { names?: string[] }): Promise<string> {
    if (pcm.byteLength === 0 || pcm.byteLength > PCM_MAX_BYTES || pcm.byteLength % 2 !== 0) throw new AgentError('Invalid audio')
    if (!this.available()) throw new AgentError('Voice needs whisper.cpp in ~/.local/share/whisper.cpp')
    if (this.busy) throw new AgentError('Still transcribing the previous recording')
    this.busy = true
    try {
      return await this.run(wavFromPcm(pcm), opts?.names)
    } finally {
      this.busy = false
    }
  }

  private run(wav: Buffer, names?: string[]): Promise<string> {
    const max = this.o.maxOutput ?? OUT_MAX
    return new Promise((resolve, reject) => {
      const args = whisperArgs({ model: this.o.model, lang: this.o.lang ?? 'pt', threads: this.o.threads ?? whisperThreads(availableParallelism()), prompt: buildPrompt(this.o.vocabulary ?? DEFAULT_VOCABULARY, names) })
      const child = spawn(this.o.bin, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env['PATH'] ?? '' } })
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

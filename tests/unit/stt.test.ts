import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PCM_MAX_BYTES, wavFromPcm } from '../../src/main/infrastructure/stt/provider'
import { buildPrompt, clean, DEFAULT_VOCABULARY, whisperArgs, whisperLang, whisperThreads, WhisperCppProvider } from '../../src/main/infrastructure/stt/whisper'

const dir = mkdtempSync(join(tmpdir(), 'stt-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const model = join(dir, 'model.bin')
writeFileSync(model, 'x')
/** A fake whisper-cli: a node script that reads stdin fully (the WAV) then runs `body`. */
const fake = (name: string, body: string): string => {
  const p = join(dir, name)
  writeFileSync(p, `#!${process.execPath}\nlet n = 0, head = ''\nprocess.stdin.on('data', (d) => { n += d.length; if (!head) head = d.subarray(0, 4).toString() })\nprocess.stdin.on('end', () => { ${body} })\n`)
  chmodSync(p, 0o755)
  return p
}
const pcm = new Uint8Array(32_000)

describe('wavFromPcm', () => {
  it('builds a 16 kHz mono 16-bit WAV header in memory', () => {
    const w = wavFromPcm(new Uint8Array([1, 0, 2, 0]))
    expect(w.length).toBe(48)
    expect(w.toString('ascii', 0, 4)).toBe('RIFF')
    expect(w.readUInt32LE(4)).toBe(40)
    expect(w.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect([w.readUInt16LE(20), w.readUInt16LE(22), w.readUInt32LE(24), w.readUInt32LE(28), w.readUInt16LE(32), w.readUInt16LE(34)]).toEqual([1, 1, 16000, 32000, 2, 16])
    expect(w.toString('ascii', 36, 40)).toBe('data')
    expect(w.readUInt32LE(40)).toBe(4)
    expect([...w.subarray(44)]).toEqual([1, 0, 2, 0])
  })
})

describe('clean', () => {
  it('keeps one line of plain text, without markers or control characters', () => {
    expect(clean(' Hello\x1b[31m\n  world [BLANK_AUDIO]\u0007 ')).toBe('Hello [31m world')
    expect(clean('x'.repeat(50), 10)).toHaveLength(10)
  })
})

describe('whisper argv', () => {
  it('threads: cores - 4, between 4 and 8', () => {
    expect([2, 4, 8, 12, 32].map(whisperThreads)).toEqual([4, 4, 4, 8, 8])
  })
  it('language: pt unless auto or a 2-letter code', () => {
    expect([undefined, 'auto', 'en', 'PT', 'portuguese', 'e', '', 'pt;'].map(whisperLang)).toEqual(['pt', 'auto', 'en', 'pt', 'pt', 'pt', 'pt', 'pt'])
  })
  it('prompt has the vocabulary and the names', () => {
    const p = buildPrompt(DEFAULT_VOCABULARY, ['Gia', 'Léo'])
    for (const w of ['Claude Code', 'Supabase', 'Next.js', 'worktree', 'pull request', 'Orchestrator', 'Gia', 'Léo']) expect(p).toContain(w)
    expect(buildPrompt('custom words', ['Max'])).toBe('custom words Nomes: Max.')
  })
  it('prompt strips control and shell characters, long names, and is capped', () => {
    const p = buildPrompt('a; $(rm) | `x` "q" <b> >c\nd\x07e', ['ok', 'x'.repeat(41), 'Zoe\n; ls'])
    expect(p).not.toMatch(/[;$()|`"<>\n]/)
    expect(p).not.toContain('\x07')
    expect(p).toContain('ok')
    expect(p).not.toContain('xxxx')
    expect(buildPrompt('word '.repeat(500), [])).toHaveLength(599)
    expect(buildPrompt('v', Array.from({ length: 100 }, (_, i) => `n${i}`)).split(',').length).toBeLessThanOrEqual(40)
  })
  it('a prompt can never start with a dash; empty means no --prompt', () => {
    for (const p of [buildPrompt('', ['--model']), buildPrompt('--model x', []), buildPrompt('- -l', ['-x'])]) expect(p.startsWith('-')).toBe(false)
    const a = whisperArgs({ model: 'm', lang: 'pt', threads: 8, prompt: buildPrompt('', []) })
    expect(a).not.toContain('--prompt')
    expect(whisperArgs({ model: 'm', lang: 'pt', threads: 8, prompt: 'hi' })).toEqual(['-m', 'm', '-f', '-', '-nt', '-np', '-l', 'pt', '-t', '8', '--prompt', 'hi', '-of', '/dev/null'])
  })
  it('the provider passes lang, threads and prompt (names included) to the binary', async () => {
    const bin = fake('argv', "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
    const a = JSON.parse(await new WhisperCppProvider({ bin, model, lang: 'en', threads: 6, vocabulary: 'Meu vocabulario' }).transcribe(pcm, { names: ['Gia'] })) as string[]
    expect(a.slice(a.indexOf('-l'), a.indexOf('-l') + 4)).toEqual(['-l', 'en', '-t', '6'])
    expect(a[a.indexOf('--prompt') + 1]).toBe('Meu vocabulario Nomes: Gia.')
  })
})

describe('WhisperCppProvider (fake binary)', () => {
  it('sends a WAV on stdin and returns the cleaned text', async () => {
    const bin = fake('ok', "process.stdout.write(head === 'RIFF' && n === 32044 ? ' hello\\x07 there\\n' : 'bad input')")
    const p = new WhisperCppProvider({ bin, model })
    expect(p.available()).toBe(true)
    expect(await p.transcribe(pcm)).toBe('hello there')
  })
  it('reports unavailable without the binary or the model, or when they are not regular files', async () => {
    expect(new WhisperCppProvider({ bin: join(dir, 'nope'), model }).available()).toBe(false)
    expect(new WhisperCppProvider({ bin: fake('x1', ''), model: join(dir, 'nope') }).available()).toBe(false)
    expect(new WhisperCppProvider({ bin: dir, model }).available()).toBe(false)
    await expect(new WhisperCppProvider({ bin: join(dir, 'nope'), model }).transcribe(pcm)).rejects.toThrow(/whisper\.cpp/)
  })
  it('kills it on timeout', async () => {
    const bin = fake('slow', 'setTimeout(() => {}, 60000)')
    const t = Date.now()
    await expect(new WhisperCppProvider({ bin, model, timeoutMs: 300 }).transcribe(pcm)).rejects.toThrow(/too long/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
  it('stops on a huge output', async () => {
    const bin = fake('big', "const c = 'a'.repeat(100000); for (let i = 0; i < 50; i++) process.stdout.write(c)")
    await expect(new WhisperCppProvider({ bin, model, maxOutput: 1000 }).transcribe(pcm)).rejects.toThrow(/too long/)
  })
  it('fails on a non-zero exit', async () => {
    await expect(new WhisperCppProvider({ bin: fake('fail', 'process.exit(3)'), model }).transcribe(pcm)).rejects.toThrow(/failed/)
  })
  it('refuses a concurrent request, then works again', async () => {
    const p = new WhisperCppProvider({ bin: fake('wait', "setTimeout(() => process.stdout.write('done'), 400)"), model })
    const first = p.transcribe(pcm)
    await expect(p.transcribe(pcm)).rejects.toThrow(/Still transcribing/)
    expect(await first).toBe('done')
    expect(await p.transcribe(pcm)).toBe('done')
  })
  it('abort() kills a transcription in progress and frees the provider', async () => {
    const p = new WhisperCppProvider({ bin: fake('hang', 'setTimeout(() => {}, 60000)'), model })
    const run = p.transcribe(pcm)
    await new Promise((r) => setTimeout(r, 200))
    p.abort()
    await expect(run).rejects.toThrow(/cancelled/)
    p.abort() // nothing running: harmless
    expect(await new WhisperCppProvider({ bin: fake('after', "process.stdout.write('ok')"), model }).transcribe(pcm)).toBe('ok')
  })
  it('refuses empty, odd or over-long audio before running anything', async () => {
    const p = new WhisperCppProvider({ bin: fake('never', "require('fs').writeFileSync(process.argv[1] + '.ran', '1')"), model })
    for (const bad of [new Uint8Array(0), new Uint8Array(3), new Uint8Array(PCM_MAX_BYTES + 2)]) await expect(p.transcribe(bad)).rejects.toThrow(/Invalid audio/)
    expect(existsSync(join(dir, 'never.ran'))).toBe(false)
  })
})

// the real whisper.cpp, when it is installed on this machine
const base = join(homedir(), '.local', 'share', 'whisper.cpp')
const bin = join(base, 'src', 'build', 'bin', 'whisper-cli')
const wav = join(base, 'src', 'samples', 'jfk.wav')
describe.skipIf(![bin, join(base, 'models', 'ggml-base.bin'), wav].every(existsSync))('WhisperCppProvider (real whisper.cpp)', () => {
  it('transcribes jfk.wav', async () => {
    const data = readFileSync(wav)
    const text = await new WhisperCppProvider({ bin, model: join(base, 'models', 'ggml-base.bin'), lang: 'en' }).transcribe(new Uint8Array(data.subarray(44)))
    expect(text.toLowerCase()).toContain('country')
  }, 60_000)
})

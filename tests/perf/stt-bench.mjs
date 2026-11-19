/* global process, console, performance */
// STT benchmark on the SYNTHETIC pt-BR set (Piper TTS, not a human voice). Run: npm run perf:stt  (STT_REPS=n timing repetitions, default 3)
// The argv comes from the app's own code: stt-lib.ts re-exports WhisperCppProvider, which is bundled here with rolldown.
import { rolldown } from 'rolldown'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir, loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'tests/perf/out')
const VOICE = join(ROOT, 'tests/fixtures/voice')
const MODELS = join(VOICE, '.cache/models')
const BASE = join(homedir(), '.local/share/whisper.cpp')
const BIN = join(BASE, 'src/build/bin/whisper-cli')
const REPS = Number(process.env.STT_REPS ?? 3)
mkdirSync(OUT, { recursive: true })

const bundle = join(OUT, 'stt-lib.bundle.mjs')
await (await rolldown({ input: join(ROOT, 'tests/perf/stt-lib.ts'), platform: 'node', logLevel: 'silent' })).write({ file: bundle, format: 'esm' })
const L = await import(pathToFileURL(bundle).href)

const phrases = JSON.parse(readFileSync(join(VOICE, 'phrases.json'), 'utf8'))
const clips = phrases.flatMap((p) => [false, true].map((pad) => ({ ...p, pad, key: p.id + (pad ? '.pad' : ''), len: p.id[0] === 'l' ? 'long' : p.id[0] === 's' ? 'short' : 'medium' })))
for (const c of clips) {
  const wav = join(VOICE, c.key + '.wav')
  if (!existsSync(wav)) throw new Error(`missing ${wav}; run scripts/voice-fixtures.sh`)
  c.pcm = new Uint8Array(readFileSync(wav).subarray(44)) // the generated WAVs have a plain 44-byte header; the app sends raw PCM too
}
const vocab = L.vocabTerms(L.DEFAULT_VOCABULARY)
const promptTerms = [...vocab, ...L.AGENT_NAMES]

// -ac wrapper: same argv from the app's builder, plus the audio-context flag (checked in `whisper-cli --help`)
const help = (r => r.stdout + r.stderr)(spawnSync(BIN, ['--help'], { encoding: 'utf8' })) // the usage text goes to stderr
const hasAc = /--audio-ctx/.test(help)
const acBin = join(OUT, 'whisper-ac768.sh')
writeFileSync(acBin, `#!/bin/sh\nexec '${BIN}' "$@" -ac 768\n`)
chmodSync(acBin, 0o755)

const NAMES = L.AGENT_NAMES
const threads = L.whisperThreads(availableParallelism())
const m = (f) => join(MODELS, `ggml-${f}.bin`)
const only = (keys) => (c) => keys.includes(c.key)
const f10 = only(['s1', 's2', 's3', 's4', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'])
const options = [
  { id: 'a', label: 'base, old args (-l auto, 4 thr, no prompt)', model: join(BASE, 'models/ggml-base.bin'), lang: 'auto', threads: 4, vocabulary: '', names: false },
  { id: 'b', label: 'base, new args (-l pt, prompt)', model: join(BASE, 'models/ggml-base.bin'), lang: 'pt', threads, vocabulary: L.DEFAULT_VOCABULARY, names: true },
  { id: 'c', label: 'base, new args, no prompt', model: join(BASE, 'models/ggml-base.bin'), lang: 'pt', threads, vocabulary: '', names: false },
  { id: 'd', label: 'small, new args', model: m('small'), lang: 'pt', threads, vocabulary: L.DEFAULT_VOCABULARY, names: true },
  ...(hasAc ? [{ id: 'e', label: 'small, new args, -ac 768', model: m('small'), lang: 'pt', threads, vocabulary: L.DEFAULT_VOCABULARY, names: true, bin: acBin }] : []),
  { id: 'f', label: 'large-v3-turbo-q5_0, new args (10 clean clips)', model: m('large-v3-turbo-q5_0'), lang: 'pt', threads, vocabulary: L.DEFAULT_VOCABULARY, names: true, reps: 1, filter: (c) => !c.pad && f10(c) },
]
const only_ = process.env.STT_ONLY?.split(',')
const keys = process.env.STT_CLIPS?.split(',') // optional: only these clip keys (timing pass)
const TAG = process.env.STT_TAG ?? ''

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN }
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? NaN }
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-')

const raw = { synthetic: true, tts: 'piper-tts 1.8.0, pt_BR-faber-medium', reps: REPS, loadavgStart: loadavg(), runs: [] }
const rows = []
for (const o of options) {
  if (only_ && !only_.includes(o.id)) continue
  const p = new L.WhisperCppProvider({ bin: o.bin ?? BIN, model: o.model, lang: o.lang, threads: o.threads, vocabulary: o.vocabulary, timeoutMs: 600_000 })
  if (!p.available()) { console.error(`option ${o.id}: model missing, skipped`); continue }
  const reps = keys ? REPS : (o.reps ?? REPS)
  const res = []
  for (const c of clips.filter(keys ? (c) => keys.includes(c.key) : (o.filter ?? (() => true)))) {
    const times = []
    let text = ''
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now()
      const out = await p.transcribe(c.pcm, o.names ? { names: NAMES } : undefined)
      times.push((performance.now() - t0) / 1000)
      if (r === 0) text = out
    }
    const x = { opt: o.id, clip: c.key, len: c.len, pad: c.pad, sec: median(times), times, text, ref: c.text, wer: L.wer(c.text, text), trunc: L.truncated(c.text, text), halluc: L.hallucinated(promptTerms, c.text, text), terms: c.terms.map((t) => L.hasTerm(text, t)) }
    res.push(x)
    raw.runs.push(x)
  }
  const sum = (a) => a.reduce((s, v) => s + v, 0)
  const tt = res.flatMap((r) => r.terms)
  const hall = (rs) => sum(rs.map((r) => r.halluc.length))
  rows.push({ id: o.id, label: o.label, n: res.length, median: median(res.map((r) => r.sec)), p95: p95(res.map((r) => r.sec)), long: median(res.filter((r) => r.len === 'long' && !r.pad).map((r) => r.sec)), wer: sum(res.map((r) => r.wer)) / res.length, termAcc: tt.filter(Boolean).length / tt.length, trunc: res.filter((r) => r.trunc).length, hallPad: hall(res.filter((r) => r.pad)), hallAll: hall(res) })
  console.error(`done ${o.id}`)
}
raw.loadavgEnd = loadavg()
raw.rows = rows
writeFileSync(join(OUT, `stt-bench${TAG}.json`), JSON.stringify(raw, null, 1))

const md = [
  `STT benchmark on SYNTHETIC pt-BR speech (Piper ${raw.tts}), 20 phrases x clean/padded; not a human voice. Timing = median of ${REPS} runs per clip (option f: 1); load average at start ${raw.loadavgStart.map((v) => v.toFixed(1)).join(' ')}, at end ${raw.loadavgEnd.map((v) => v.toFixed(1)).join(' ')}.`,
  '',
  '| option | clips | median s | p95 s | long clean median s | WER | term acc | truncated | hallucinated (padded / all) |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.id}. ${r.label} | ${r.n} | ${f(r.median)} | ${f(r.p95)} | ${f(r.long)} | ${f(r.wer * 100, 1)}% | ${f(r.termAcc * 100, 0)}% | ${r.trunc} | ${r.hallPad} / ${r.hallAll} |`),
  '',
  'Term equivalences: case, accents and punctuation ignored; spaces inside a term optional (Next.js = Next JS = NextJS; pull request = pull-request); plural s accepted (commit = commits); whole words only.',
].join('\n')
writeFileSync(join(OUT, `stt-bench${TAG}.md`), md + '\n')
console.log(md)

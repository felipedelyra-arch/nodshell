// Regression test of the dictation defaults on the SYNTHETIC pt-BR set (Piper TTS, not a human voice).
// Off unless NODSHELL_STT_FIXTURES=1 (npm run test:stt) and skipped when the WAVs (scripts/voice-fixtures.sh) or whisper.cpp are absent.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { whisperFromEnv } from '../../src/main/infrastructure/stt/whisper'
import { AGENT_NAMES, hallucinated, truncated, wer } from '../perf/stt-lib'

const dir = join(__dirname, '../fixtures/voice')
const phrases: { id: string; text: string }[] = existsSync(join(dir, 'phrases.json')) ? JSON.parse(readFileSync(join(dir, 'phrases.json'), 'utf8')) : []
const clips = phrases.flatMap((p) => [p.id, `${p.id}.pad`].map((key) => ({ key, text: p.text, pad: key.endsWith('.pad') })))
const provider = whisperFromEnv()
const on = process.env['NODSHELL_STT_FIXTURES'] === '1' && provider.available() && clips.length > 0 && clips.every((c) => existsSync(join(dir, `${c.key}.wav`)))
/** Option b (base, app defaults) measured 23.4% mean WER on this set (no-prompt option c: 30.4%); the limit is 30%: margin for run-to-run variation, still failing if the prompt stops helping. */
const WER_MAX = 0.3
const SECONDS_MAX = 10

describe.skipIf(!on)('dictation on the synthetic pt-BR set (app defaults)', () => {
  it('has no truncation, no invented agent name, WER under the limit and each call under 10 s', async () => {
    let werSum = 0
    for (const c of clips) {
      const t0 = performance.now()
      const text = await provider.transcribe(new Uint8Array(readFileSync(join(dir, `${c.key}.wav`)).subarray(44)), { names: AGENT_NAMES })
      const sec = (performance.now() - t0) / 1000
      werSum += wer(c.text, text)
      expect(truncated(c.text, text), `${c.key} truncated: ${text}`).toBe(false)
      if (c.pad) expect(hallucinated(AGENT_NAMES, c.text, text), `${c.key} invented a name: ${text}`).toEqual([])
      expect(sec, `${c.key} took ${sec.toFixed(1)} s`).toBeLessThan(SECONDS_MAX)
    }
    expect(werSum / clips.length).toBeLessThanOrEqual(WER_MAX)
  }, 600_000)
})

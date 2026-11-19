// Pure helpers of the STT benchmark and its regression test (WER, term matching). Bundled by stt-bench.mjs, imported by vitest.
export { DEFAULT_VOCABULARY, WhisperCppProvider, whisperThreads } from '../../src/main/infrastructure/stt/whisper'

/** Lower-case, accents removed, anything that is not a letter or digit becomes a space. Used on BOTH sides of every comparison. */
export const words = (s: string): string[] => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wer(ref: string, hyp: string): number {
  const r = words(ref)
  const h = words(hyp)
  if (r.length === 0) return h.length === 0 ? 0 : 1
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1))
    prev = cur
  }
  return (prev[h.length] ?? 0) / r.length
}

/** Does `term` appear in `text`? Equivalences: case, accents and punctuation ignored, spaces between the term's parts optional
 *  ("Next.js" = "Next JS" = "NextJS"; "pull request" = "pull-request" = "pullrequest"), and a plural "s" is accepted ("commits"). */
export function hasTerm(text: string, term: string): boolean {
  const re = new RegExp(`(^| )${words(term).join(' ?')}s?( |$)`)
  return re.test(words(text).join(' '))
}

/** The reference's last two words are both absent from the output. */
export function truncated(ref: string, hyp: string): boolean {
  const h = new Set(words(hyp))
  return words(ref).slice(-2).every((w) => !h.has(w))
}

/** Prompt terms (vocabulary + agent names) that the output contains but the reference does not. */
export const hallucinated = (terms: readonly string[], ref: string, hyp: string): string[] => terms.filter((t) => hasTerm(hyp, t) && !hasTerm(ref, t))

export const AGENT_NAMES = ['Gia', 'Léo', 'Opal', 'Max', 'Ian']
/** The list inside DEFAULT_VOCABULARY ("... sobre A, B, C e D."). */
export const vocabTerms = (vocab: string): string[] => vocab.replace(/^.*? sobre /, '').replace(/\.$/, '').split(/, | e /)

import { describe, expect, it } from 'vitest'
import { hallucinated, hasTerm, truncated, vocabTerms, wer } from '../perf/stt-lib'
import { DEFAULT_VOCABULARY } from '../../src/main/infrastructure/stt/whisper'

describe('wer', () => {
  it('is 0 for the same words, ignoring case, accents and punctuation', () => expect(wer('Léo, faz o commit!', 'leo faz o COMMIT')).toBe(0))
  it('counts one substitution in four words', () => expect(wer('um dois três quatro', 'um dois tres cinco')).toBe(0.25))
  it('counts a deletion', () => expect(wer('a b c d', 'a b d')).toBe(0.25))
  it('counts an insertion', () => expect(wer('a b', 'a x b')).toBe(0.5))
  it('is 1 for empty output and can pass 1', () => {
    expect(wer('a b c', '')).toBe(1)
    expect(wer('a', 'x y z')).toBe(3)
  })
})

describe('terms', () => {
  it('accepts the Next.js spellings and plurals but not word fragments', () => {
    for (const t of ['Next.js', 'Next JS', 'NextJS', 'next.js']) expect(hasTerm(`abre o ${t} agora`, 'Next.js')).toBe(true)
    expect(hasTerm('os commits novos', 'commit')).toBe(true)
    expect(hasTerm('que magia', 'Gia')).toBe(false)
    expect(hasTerm('Pull-request aberto', 'pull request')).toBe(true)
  })
  it('detects truncation and hallucinated prompt terms', () => {
    expect(truncated('faz o commit agora', 'faz o commit')).toBe(false)
    expect(truncated('faz o commit agora mesmo', 'faz o commit')).toBe(true)
    expect(hallucinated(['Gia', 'Max'], 'faz o commit', 'Gia faz o commit')).toEqual(['Gia'])
    expect(vocabTerms(DEFAULT_VOCABULARY)).toContain('pull request')
    expect(vocabTerms(DEFAULT_VOCABULARY)).toContain('backend')
  })
})

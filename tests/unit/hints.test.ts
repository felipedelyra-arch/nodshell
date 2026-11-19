import { describe, expect, it } from 'vitest'
import { blockRms, describePreview, READY_MS, smoothLevel, statusSegment } from '../../src/renderer/command/hints'

describe('level', () => {
  it('rms of a block, zero for silence or nothing', () => {
    expect(blockRms([])).toBe(0)
    expect(blockRms([0, 0, 0])).toBe(0)
    expect(blockRms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5)
  })
  it('rises fast, falls slowly, stays within 0..1', () => {
    const up = smoothLevel(0, 0.1)
    expect(up).toBeGreaterThan(0.25)
    expect(smoothLevel(up, 0)).toBeLessThan(up)
    expect(smoothLevel(up, 0)).toBeGreaterThan(up * 0.8)
    expect(smoothLevel(0.9, 1)).toBeLessThanOrEqual(1)
  })
})

describe('statusSegment', () => {
  const ready = { kind: 'ready', fieldText: 'x', until: 1000 + READY_MS } as const
  it('recording (also the tail) and transcribing win over any note', () => {
    expect(statusSegment('listening', { kind: 'error', text: 'e' }, 0)?.text).toBe('Listening…')
    expect(statusSegment('transcribing', ready, 1000)?.text).toBe('Transcribing…')
  })
  it('ready lasts 4 s, then nothing', () => {
    expect(statusSegment('idle', ready, 1000)).toEqual({ kind: 'ready', text: 'Dictated. Press Enter to send.' })
    expect(statusSegment('idle', ready, 1000 + READY_MS)).toBeNull()
  })
  it('an error stays until the note is cleared (typing, next dictation)', () => {
    expect(statusSegment('idle', { kind: 'error', text: 'Could not open the microphone.' }, 1e9)).toEqual({ kind: 'error', text: 'Could not open the microphone.' })
    expect(statusSegment('idle', undefined, 0)).toBeNull()
  })
})

describe('describePreview', () => {
  const t = (...n: string[]) => n.map((name) => ({ name }))
  it('formats one name, the same name twice, a group and long lists', () => {
    expect(describePreview({ targets: t('Zoe'), refused: [] }).ok).toBe('→ Zoe')
    expect(describePreview({ targets: t('Orchestrator', 'Orchestrator'), refused: [] }).ok).toBe('→ Orchestrator +1')
    expect(describePreview({ targets: t('Mia', 'Ray'), refused: [], group: 'Frontend' }).ok).toBe('→ FRONTEND · Mia, Ray')
    expect(describePreview({ targets: t('A', 'B', 'C', 'D', 'E'), refused: [] }).ok).toBe('→ A, B, C +2')
  })
  it('refusals come as text, with or without targets', () => {
    expect(describePreview({ targets: [], refused: [{ name: '@zoe', reason: 'No agent' }] })).toEqual({ ok: '', err: '@zoe No agent' })
  })
})

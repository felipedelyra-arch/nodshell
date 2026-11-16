import { describe, expect, it } from 'vitest'
import { AgentError } from '../../src/main/domain/agent'
import { BUILTIN_PRESETS, PresetService, type Preset, type PresetRepo } from '../../src/main/domain/preset'
import { LIVE_HARD_MAX } from '../../src/shared/agent'
import { channels } from '../../src/shared/ipc/channels'
import { validatePreset, type PresetFields } from '../../src/shared/preset'

const ok: PresetFields = { name: 'Frontend', role: 'frontend', model: null, systemPrompt: 'be nice' }
const id = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'

describe('validatePreset', () => {
  it('accepts a valid preset and trims the name', () => {
    expect(validatePreset({ ...ok, name: '  Web UI  ', model: 'opus' })).toEqual({ ok: true, value: { ...ok, name: 'Web UI', model: 'opus' } })
    expect(validatePreset({ ...ok, name: 'x'.repeat(40), systemPrompt: 'y'.repeat(20_000) }).ok).toBe(true)
  })
  it.each([
    ['empty name', { name: '' }, 'name'],
    ['blank name', { name: '   ' }, 'name'],
    ['name too long', { name: 'x'.repeat(41) }, 'name'],
    ['name with control char', { name: 'a\nb' }, 'name'],
    ['path role', { role: '../x' }, 'role'],
    ['dash role', { role: '-x' }, 'role'],
    ['uppercase role', { role: 'Front' }, 'role'],
    ['empty role', { role: '' }, 'role'],
    ['role too long', { role: 'a'.repeat(25) }, 'role'],
    ['flag as model', { model: '--dangerously-skip-permissions' as never }, 'model'],
    ['prompt too long', { systemPrompt: 'y'.repeat(20_001) }, 'systemPrompt'],
    ['prompt with NUL', { systemPrompt: 'a\0b' }, 'systemPrompt'],
  ] as const)('rejects %s', (_n, patch, field) => {
    const r = validatePreset({ ...ok, ...patch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors)).toEqual([field])
  })
})

describe('preset channel schemas', () => {
  const save = channels['preset:save'].in
  it('accepts create and update', () => {
    expect(save.safeParse({ name: 'A', role: 'a', model: null, systemPrompt: '' }).success).toBe(true)
    expect(save.safeParse({ id, name: 'A', role: 'a', model: 'haiku', systemPrompt: 'x' }).success).toBe(true)
  })
  it.each([
    ['bad role', { name: 'A', role: '../x', model: null, systemPrompt: '' }],
    ['bad model', { name: 'A', role: 'a', model: 'gpt', systemPrompt: '' }],
    ['empty model string', { name: 'A', role: 'a', model: '', systemPrompt: '' }],
    ['long name', { name: 'x'.repeat(41), role: 'a', model: null, systemPrompt: '' }],
    ['big prompt', { name: 'A', role: 'a', model: null, systemPrompt: 'x'.repeat(20_001) }],
    ['non-uuid id', { id: 'nope', name: 'A', role: 'a', model: null, systemPrompt: '' }],
  ])('rejects %s', (_n, input) => {
    expect(save.safeParse(input).success).toBe(false)
  })
  it('validates spawnMany and group channels', () => {
    const sm = channels['agent:spawnMany'].in
    expect(sm.safeParse({ presetId: id, count: 4, cols: 80, rows: 24, workspaceId: id }).success).toBe(true)
    expect(sm.safeParse({ presetId: id, count: 4, cols: 80, rows: 24 }).success).toBe(false) // the workspace key is required
    expect(sm.safeParse({ presetId: id, count: LIVE_HARD_MAX, cols: 80, rows: 24, workspaceId: id }).success).toBe(true)
    for (const count of [0, LIVE_HARD_MAX + 1, 1.5]) expect(sm.safeParse({ presetId: id, count, cols: 80, rows: 24, workspaceId: id }).success).toBe(false)
    expect(sm.safeParse({ presetId: 'x', count: 2, cols: 80, rows: 24, workspaceId: id }).success).toBe(false)
    const gc = channels['group:create'].in
    expect(gc.safeParse({ name: 'G', memberIds: [id] }).success).toBe(true)
    expect(gc.safeParse({ name: '', memberIds: [id] }).success).toBe(false)
    expect(gc.safeParse({ name: 'G', memberIds: [] }).success).toBe(false)
    expect(gc.safeParse({ name: 'G', memberIds: ['x'] }).success).toBe(false)
    expect(channels['group:dissolve'].in.safeParse({ id }).success).toBe(true)
    expect(channels['preset:delete'].in.safeParse({ id: 'x' }).success).toBe(false)
  })
  it('validates the squad channel: only a terminal size in, known roles and bounded groups out', () => {
    const sq = channels['squad:create']
    expect(sq.in.safeParse({ cols: 80, rows: 24, workspaceId: id, perGroup: 1 }).success).toBe(true)
    expect(sq.in.safeParse({ cols: 80, rows: 24, perGroup: 2 }).success).toBe(false) // the agents need their workspace
    expect(sq.in.safeParse({ cols: 1, rows: 24, workspaceId: id, perGroup: 2 }).success).toBe(false)
    for (const perGroup of [0, 3, 1.5]) expect(sq.in.safeParse({ cols: 80, rows: 24, workspaceId: id, perGroup }).success).toBe(false)
    expect(sq.in.safeParse({ cols: 80, rows: 24, workspaceId: id, perGroup: 2, role: 'x' }).data).toEqual({ cols: 80, rows: 24, workspaceId: id, perGroup: 2 }) // extra fields never reach main
    const agent = { id, name: 'Zoe', role: 'orchestrator', branch: 'agent/orchestrator-1', model: 'default', state: 'starting', statusUnavailable: false }
    const edge = { id, workspaceId: id, source: { kind: 'group', id }, target: { kind: 'squad', id }, template: 'From {name}', condition: '', paused: null, note: null }
    const out = { squad: { id, orchestratorId: id, groupIds: [id] }, orchestrator: agent, groups: [{ id, name: 'Frontend', role: 'frontend', memberIds: [id, id] }], agents: [agent], edges: [edge], failed: 0 }
    expect(sq.out.safeParse({ ...out, edges: [{ ...edge, source: { kind: 'squad', id } }] }).success).toBe(false) // a squad is never a source
    expect(sq.out.safeParse(out).success).toBe(true)
    expect(sq.out.safeParse({ ...out, groups: [{ ...out.groups[0], role: 'hacker' }] }).success).toBe(false)
    expect(sq.out.safeParse({ ...out, groups: [{ ...out.groups[0], memberIds: [id, id, id] }] }).success).toBe(false)
  })
})

function memoryRepo(): PresetRepo {
  const rows = new Map<string, Preset>()
  BUILTIN_PRESETS.forEach((b, i) => rows.set(`b${i}`, { ...b, model: null, id: `b${i}`, adapter: 'claude', builtin: true, createdAt: 1 }))
  return {
    list: () => [...rows.values()],
    get: (i) => rows.get(i),
    insert: (p) => void rows.set(p.id, p),
    update: (p) => void rows.set(p.id, p),
    delete: (i) => rows.get(i)?.builtin === false && rows.delete(i),
  }
}

describe('PresetService', () => {
  const make = () => {
    let n = 0
    return new PresetService(memoryRepo(), () => `new${++n}`, () => 42)
  }
  it('creates, updates and deletes', () => {
    const s = make()
    const p = s.save(ok.name === 'Frontend' ? { ...ok, name: 'Mine' } : ok)
    expect(p).toMatchObject({ id: 'new1', name: 'Mine', adapter: 'claude', builtin: false, createdAt: 42 })
    expect(s.save({ ...ok, id: p.id, name: 'Mine 2', model: 'opus' })).toMatchObject({ id: 'new1', name: 'Mine 2', model: 'opus', createdAt: 42 })
    s.delete(p.id)
    expect(s.get(p.id)).toBeUndefined()
  })
  it('edits a built-in but refuses to delete it', () => {
    const s = make()
    expect(s.save({ ...ok, id: 'b0', systemPrompt: 'changed' })).toMatchObject({ id: 'b0', builtin: true, systemPrompt: 'changed' })
    expect(() => s.delete('b0')).toThrow('Built-in presets cannot be deleted')
  })
  it('keeps names unique case-insensitively, but allows re-saving itself', () => {
    const s = make()
    expect(() => s.save({ ...ok, name: 'REVIEWERS' })).toThrow('already exists')
    expect(() => s.save({ ...ok, id: 'b3', name: 'reviewers' })).not.toThrow()
  })
  it('refuses unknown ids and invalid input', () => {
    const s = make()
    expect(() => s.save({ ...ok, id: 'zzz', name: 'Q' })).toThrow(AgentError)
    expect(() => s.delete('zzz')).toThrow('Unknown preset')
    expect(() => s.save({ ...ok, name: 'Q', role: '../x' })).toThrow(AgentError)
  })
  it('has the five built-ins', () => {
    expect(BUILTIN_PRESETS.map((b) => b.role)).toEqual(['frontend', 'backend', 'tester', 'reviewer', 'orchestrator'])
  })
})

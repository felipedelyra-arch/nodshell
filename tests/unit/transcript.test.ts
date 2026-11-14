import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../../src/main/infrastructure/adapters/claude'
import { claudeProjectsDir, hasTranscript, readLastAssistantText, validateTranscriptPath } from '../../src/main/infrastructure/adapters/transcript'
import { scrapeText, TAIL_MAX } from '../../src/main/infrastructure/pty/scrape'
import { LAST_MESSAGE_MAX } from '../../src/shared/agent'

const sid = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
const other = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d'

const user = (text: string) => JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: text } })
const toolResult = () => JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
const asst = (id: string, content: unknown, extra: object = {}) => JSON.stringify({ type: 'assistant', sessionId: sid, message: { id, role: 'assistant', content }, ...extra })
const text = (t: string) => [{ type: 'text', text: t }]
const tool = () => [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]

let home: string, projects: string, proj: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'transcript-test-'))
  projects = join(home, '.claude', 'projects')
  proj = join(projects, '-w-repo')
  mkdirSync(proj, { recursive: true })
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

function file(lines: string[], name = `${sid}.jsonl`, trailingNewline = true): string {
  const p = join(proj, name)
  writeFileSync(p, lines.join('\n') + (trailingNewline ? '\n' : ''))
  return p
}

describe('readLastAssistantText', () => {
  it('normal turn: the last assistant text, with all text blocks of that message', () => {
    const p = file([user('hi'), asst('m1', text('first answer')), user('again'), asst('m2', [{ type: 'thinking', thinking: 'hmm' }]), asst('m2', text('part one')), asst('m2', text('part two'))])
    expect(readLastAssistantText(p)).toBe('part one\n\npart two')
  })
  it('string content is accepted', () => {
    expect(readLastAssistantText(file([user('x'), asst('m1', 'plain string reply')]))).toBe('plain string reply')
  })
  it('skips a last entry that is tool-only, and the tool results after it', () => {
    const p = file([user('go'), asst('m1', text('Running ls now.')), asst('m2', tool()), toolResult()])
    expect(readLastAssistantText(p)).toBe('Running ls now.')
  })
  it('skips sidechain (sub-agent) entries', () => {
    const p = file([user('go'), asst('m1', text('main answer')), asst('s1', text('sub-agent chatter'), { isSidechain: true })])
    expect(readLastAssistantText(p)).toBe('main answer')
  })
  it('tolerates a truncated last line and unrelated or malformed lines', () => {
    const p = file([asst('m1', text('complete')), '{"type":"summary"}', 'not json', asst('m2', text('half')).slice(0, 40)], `${sid}.jsonl`, false)
    expect(readLastAssistantText(p)).toBe('complete')
  })
  it('skips a very long line without buffering it, and still finds the message before it', () => {
    const huge = asst('m2', text('x'.repeat(5 * 1024 * 1024)))
    const p = file([asst('m1', text('before the giant')), huge, 'garbage'])
    expect(readLastAssistantText(p)).toBe('before the giant')
  })
  it('handles messages across chunk boundaries and caps the text', () => {
    const big = 'y'.repeat(LAST_MESSAGE_MAX + 5000)
    const p = file([user('q'), asst('m1', text(big)), ...Array.from({ length: 2000 }, (_, i) => `{"type":"progress","n":${i}}`)])
    expect(readLastAssistantText(p)).toBe(big.slice(0, LAST_MESSAGE_MAX))
  })
  it('empty file and missing file give null', () => {
    expect(readLastAssistantText(file([], `${sid}.jsonl`, false))).toBeNull()
    expect(readLastAssistantText(join(proj, 'missing.jsonl'))).toBeNull()
  })
  it('a file with only user and tool entries gives null', () => {
    expect(readLastAssistantText(file([user('a'), asst('m1', tool()), toolResult()]))).toBeNull()
  })
})

describe('validateTranscriptPath', () => {
  it('accepts the session file inside the projects dir and returns its real path', () => {
    const p = file([asst('m1', text('a'))])
    expect(validateTranscriptPath(p, sid, projects)).toBe(p)
  })
  it('rejects another session, a wrong extension, a relative path, and a bad session id', () => {
    file([asst('m1', text('a'))], `${other}.jsonl`)
    file([asst('m1', text('a'))], `${sid}.json`)
    expect(validateTranscriptPath(join(proj, `${other}.jsonl`), sid, projects)).toBeNull()
    expect(validateTranscriptPath(join(proj, `${sid}.json`), sid, projects)).toBeNull()
    expect(validateTranscriptPath(`-w-repo/${sid}.jsonl`, sid, projects)).toBeNull()
    expect(validateTranscriptPath(join(proj, '...jsonl'), '..', projects)).toBeNull()
    expect(validateTranscriptPath(join(proj, 'missing', `${sid}.jsonl`), sid, projects)).toBeNull()
  })
  it('rejects a file outside the projects dir, directly or through a symlink or traversal', () => {
    const outside = join(home, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, `${sid}.jsonl`), asst('m1', text('secret')) + '\n')
    expect(validateTranscriptPath(join(outside, `${sid}.jsonl`), sid, projects)).toBeNull()
    const linkDir = join(projects, 'linked')
    symlinkSync(outside, linkDir)
    expect(validateTranscriptPath(join(linkDir, `${sid}.jsonl`), sid, projects)).toBeNull()
    expect(validateTranscriptPath(join(projects, '..', 'elsewhere', `${sid}.jsonl`), sid, projects)).toBeNull()
    // a symlink named like the session pointing at another session's file
    const p2 = join(projects, 'p2')
    mkdirSync(p2)
    symlinkSync(join(proj, `${other}.jsonl`), join(p2, `${sid}.jsonl`))
    expect(validateTranscriptPath(join(p2, `${sid}.jsonl`), sid, projects)).toBeNull()
  })
  it('the projects dir follows CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeProjectsDir({}, '/h')).toBe('/h/.claude/projects')
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/h')).toBe('/cfg/projects')
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: 'rel' }, '/h')).toBe('/h/.claude/projects')
  })
})

describe('ClaudeAdapter.readLastMessage', () => {
  it('reads through the validation, relative to HOME', async () => {
    const p = file([user('q'), asst('m1', text('from the transcript'))])
    const a = new ClaudeAdapter({ HOME: home, PATH: '' })
    await expect(a.readLastMessage({ sessionId: sid, transcriptPath: p })).resolves.toBe('from the transcript')
    await expect(a.readLastMessage({ sessionId: other, transcriptPath: p })).resolves.toBeNull()
    await expect(a.readLastMessage({ sessionId: sid })).resolves.toBeNull()
    await expect(new ClaudeAdapter({ HOME: '/nonexistent', PATH: '' }).readLastMessage({ sessionId: sid, transcriptPath: p })).resolves.toBeNull()
  })
})

describe('scrapeText', () => {
  it('strips ANSI, OSC and control sequences and keeps the last non-empty lines', () => {
    const raw = '\x1b]0;title\x07\x1b[?2004h\x1b[1;31mred\x1b[0m\x1b[2Cword\r\n\r\n\x1b[2K\x1bPdcs\x1b\\plain\ttab\x07\x00\r\nlast line   \r\n'
    expect(scrapeText(raw)).toBe('red word\nplain\ttab\nlast line')
  })
  it('is bounded in lines and size', () => {
    const out = scrapeText(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\r\n'))
    expect(out.split('\n')).toHaveLength(40)
    expect(out.endsWith('line 499')).toBe(true)
    expect(scrapeText('z'.repeat(TAIL_MAX * 3)).length).toBeLessThanOrEqual(8000)
    expect(scrapeText('\x1b[2J\x1b[H')).toBe('')
  })
})

describe('hasTranscript (resume only a session that has a conversation)', () => {
  it('finds <projects>/<cwd with non-alphanumerics as "-">/<session>.jsonl, and nothing outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'has-transcript-'))
    const projects = join(root, 'projects')
    const sid = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
    const cwd = '/home/u/.config/agent canvas/worktrees/ab12/frontend-1'
    expect(hasTranscript(projects, cwd, sid)).toBe(false)
    mkdirSync(join(projects, '-home-u--config-agent-canvas-worktrees-ab12-frontend-1'), { recursive: true })
    writeFileSync(join(projects, '-home-u--config-agent-canvas-worktrees-ab12-frontend-1', `${sid}.jsonl`), '{}\n')
    expect(hasTranscript(projects, cwd, sid)).toBe(true)
    expect(hasTranscript(projects, cwd, '../../etc/passwd')).toBe(false)
    expect(hasTranscript(projects, 'relative/frontend-1', sid)).toBe(false)
    expect(hasTranscript(projects, '/elsewhere', sid)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})


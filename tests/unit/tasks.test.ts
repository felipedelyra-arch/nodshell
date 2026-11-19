import { describe, expect, it } from 'vitest'
import { TaskBoard, type TaskSummary } from '../../src/main/application/tasks'
import { cleanText, previewText, taskStatus, taskTitle } from '../../src/main/domain/task'
import { TASKS_MAX, TASKS_RECENT } from '../../src/shared/flow'
import { events } from '../../src/shared/ipc/channels'

const zoe = { kind: 'agent' as const, id: 'zoe', name: 'Zoe' }
const fe = { kind: 'group' as const, id: 'gf', name: 'Frontend' }

function board() {
  const sent: [number, TaskSummary][] = []
  let n = 0
  const b = new TaskBoard((o, s) => void sent.push([o, s]), () => `t${++n}`, () => 1000)
  const last = (squadId = 'q1') => [...sent].reverse().find(([, s]) => s.squadId === squadId)?.[1]
  return { b, sent, last }
}

describe('task rules (domain)', () => {
  it('the title is the first line with text, without control characters, cut to 120', () => {
    expect(taskTitle('\n  Build the login page  \nwith a form')).toBe('Build the login page')
    expect(taskTitle('Fix\u001b[31m the\u0007 bug‮')).toBe('Fix[31m the bug')
    expect(taskTitle('x'.repeat(300))).toBe(`${'x'.repeat(119)}…`)
    expect(taskTitle('\u0001\n\u0002')).toBe('Untitled')
    expect(cleanText('a\r\nb\rc\u0000\td')).toBe('a\nb\nc\td')
    expect(cleanText('a\u2028b\u2029c\u0085d')).toBe('a\nb\nc\nd')
    expect(cleanText('z\u200bw\u200dj\ufeffs\u00adh\u2066i\u202ex\u061c')).toBe('zwjshix')
    expect(taskTitle('\u2028\u200b\u2029  Real title\u2028second')).toBe('Real title')
  })
  it('a dialog preview shows the first lines, each cut, and says how many more there are', () => {
    expect(previewText('one\n\ntwo\u001b[0m')).toBe('one\ntwo[0m')
    const many = Array.from({ length: 9 }, (_, i) => `line ${i} ${'y'.repeat(200)}`).join('\n')
    const p = previewText(many).split('\n')
    expect(p).toHaveLength(7)
    expect(p[0]).toHaveLength(160)
    expect(p[6]).toBe('… (3 more lines)')
    // a separator other than \n cannot slip extra lines past the cut, or fake a question with invisible characters
    const sneaky = ['task', ...Array.from({ length: 20 }, () => 'Allow anyway?')].join('\u2028') + '\u202e\u200b'
    const shown = previewText(sneaky)
    expect(shown.split('\n')).toHaveLength(7)
    expect(shown).not.toMatch(/[\u2028\u2029\u0085\u200b\u202e]/)
    expect(shown.endsWith('… (15 more lines)')).toBe(true)
  })
  it('a task from its recipients: queued, running from the first delivery, done or failed once none is pending', () => {
    expect(taskStatus(['new'])).toBe('queued')
    expect(taskStatus(['queued', 'new'])).toBe('queued')
    expect(taskStatus(['running', 'queued'])).toBe('running')
    expect(taskStatus(['done', 'queued'])).toBe('running')
    expect(taskStatus(['done', 'failed'])).toBe('done')
    expect(taskStatus(['failed', 'failed'])).toBe('failed')
  })
})

describe('TaskBoard', () => {
  it('one agent: queued -> running at the delivery -> done when its next turn ends; every change is reported', () => {
    const { b, last } = board()
    const t = b.create(1, 'q1', 'Build it\ndetails', zoe, ['zoe'])
    expect(t).toMatchObject({ id: 't1', squadId: 'q1', title: 'Build it', assignee: zoe, status: 'queued', createdAt: 1000 })
    expect(last()).toEqual({ squadId: 'q1', done: 0, total: 1, recent: [{ title: 'Build it', assignee: 'Zoe', status: 'queued' }], latest: [{ id: 'zoe', status: 'queued' }] })
    b.track('zoe', ['t1'], 'queued')
    b.settle('t1')
    b.stopped('zoe') // a turn that ended before the delivery does not count
    expect(t.status).toBe('queued')
    b.track('zoe', ['t1'], 'delivered')
    expect(last()).toMatchObject({ done: 0, total: 1, recent: [{ status: 'running' }], latest: [{ id: 'zoe', status: 'running' }] })
    b.stopped('zoe')
    expect(last()).toMatchObject({ done: 1, total: 1, recent: [{ status: 'done' }] })
    b.down('zoe') // finished stays finished
    expect(t.status).toBe('done')
    const uuid = '3f2b8c1e-8a4d-4f6e-9b1a-2c7d5e9f0a11'
    const out = { ...last()!, squadId: uuid, latest: last()!.latest.map((l) => ({ ...l, id: uuid })) }
    expect(events['tasks:changed'].parse(out)).toEqual(out) // what main sends passes the event schema
    expect(() => events['tasks:changed'].parse({ ...out, latest: [{ id: 'zoe', status: 'done' }] })).toThrow() // ids only, never a name
  })

  it('a group: running from the first delivery, done when every member that got it has finished', () => {
    const { b } = board()
    const t = b.create(1, 'q1', 'Style it', fe, ['zoe', 'pip'])
    b.track('zoe', ['t1'], 'queued')
    b.track('pip', ['t1'], 'queued')
    b.track('zoe', ['t1'], 'delivered')
    expect(t.status).toBe('running')
    b.stopped('zoe')
    expect(t.status).toBe('running') // pip has not had it yet
    b.track('pip', ['t1'], 'delivered')
    b.stopped('pip')
    expect(t.status).toBe('done')
    // a member the queue refused does not hold the group back
    const u = b.create(1, 'q1', 'Again', fe, ['zoe', 'pip'])
    b.track('zoe', [u.id], 'queued')
    b.settle(u.id) // pip: refused (e.g. too many messages waiting)
    expect(u.recipients.get('pip')).toBe('failed')
    b.track('zoe', [u.id], 'delivered')
    b.stopped('zoe')
    expect(u.status).toBe('done')
  })

  it('failed: the recipient closed, exited or in error before finishing, every delivery refused, or the text left unsent', () => {
    const { b } = board()
    const closed = b.create(1, 'q1', 'a', zoe, ['zoe'])
    b.track('zoe', [closed.id], 'queued')
    b.track('zoe', [closed.id], 'delivered')
    b.down('zoe')
    expect(closed.status).toBe('failed')
    const refused = b.create(1, 'q1', 'b', fe, ['zoe', 'pip'])
    b.settle(refused.id)
    expect(refused.status).toBe('failed')
    const unsent = b.create(1, 'q1', 'c', zoe, ['leo'])
    b.track('leo', [unsent.id], 'queued')
    b.track('leo', [unsent.id], 'delivered')
    b.track('leo', [unsent.id], 'dropped')
    expect(unsent.status).toBe('failed')
    // put back after a failed paste: queued again, not failed
    const back = b.create(1, 'q1', 'd', zoe, ['ada'])
    b.track('ada', [back.id], 'queued')
    b.track('ada', [back.id], 'delivered')
    b.track('ada', [back.id], 'returned')
    expect(back.status).toBe('queued')
    b.stopped('ada')
    expect(back.status).toBe('queued')
    // a late event for a finished recipient changes nothing
    b.track('zoe', [closed.id], 'delivered')
    expect(closed.status).toBe('failed')
  })

  it(`keeps at most ${TASKS_MAX} per squad, dropping the oldest finished first; lists the latest ${TASKS_RECENT}, newest first`, () => {
    const { b, last } = board()
    const first = b.create(1, 'q1', 'first', zoe, ['zoe'])
    const second = b.create(1, 'q1', 'second', zoe, ['zoe'])
    b.settle(second.id) // failed: finished
    for (let i = 3; i <= TASKS_MAX; i++) b.create(1, 'q1', `task ${i}`, zoe, ['zoe'])
    b.create(1, 'q2', 'other squad', zoe, ['zoe'])
    expect(b.list('q1')).toHaveLength(TASKS_MAX)
    b.create(1, 'q1', 'one more', zoe, ['zoe'])
    expect(b.list('q1')).toHaveLength(TASKS_MAX)
    expect(b.list('q1').map((t) => t.title)).toContain('first') // still pending, kept
    expect(b.list('q1').map((t) => t.title)).not.toContain('second')
    b.create(1, 'q1', 'and another', zoe, ['zoe'])
    expect(b.list('q1').map((t) => t.title)).not.toContain('first') // nothing finished left: the oldest goes
    expect(first.status).toBe('queued')
    expect(b.list('q2')).toHaveLength(1)
    const s = last()!
    expect(s.total).toBe(TASKS_MAX)
    expect(s.recent).toHaveLength(TASKS_RECENT)
    expect(s.recent[0]!.title).toBe('and another')
  })

  it('latest: per assignee, the state of its newest task (agent or group)', () => {
    const { b, last } = board()
    b.create(1, 'q1', 'a', zoe, ['zoe'])
    b.create(1, 'q1', 'b', fe, ['zoe', 'pip'])
    b.track('zoe', ['t1'], 'delivered')
    b.down('zoe')
    expect(last()!.latest).toEqual([{ id: 'zoe', status: 'failed' }, { id: 'gf', status: 'running' }])
    b.create(1, 'q1', 'c', zoe, ['zoe'])
    expect(last()!.latest).toContainEqual({ id: 'zoe', status: 'queued' }) // a newer task replaces the failed one
  })

  it('tasks go with their squad or their window', () => {
    const { b } = board()
    b.create(1, 'q1', 'a', zoe, ['zoe'])
    b.create(1, 'q2', 'b', zoe, ['pip'])
    b.create(2, 'q3', 'c', zoe, ['leo'])
    b.dropSquad('q1')
    expect(b.summary('q1')).toEqual({ squadId: 'q1', done: 0, total: 0, recent: [], latest: [] })
    b.dropOwner(1)
    expect(b.list('q2')).toEqual([])
    expect(b.list('q3')).toHaveLength(1)
  })
})

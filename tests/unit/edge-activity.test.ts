import { describe, expect, it } from 'vitest'
import { activityWords, edgeActivity, runnerPath, type EdgeContext } from '../../src/renderer/flow/activity'

const ctx = (c: Partial<EdgeContext> = {}): EdgeContext => ({ orchestrator: true, source: ['idle', 'idle'], target: ['idle'], firing: false, delegating: false, taskFailed: false, flowsPaused: false, processesPaused: false, ...c })
const live = { paused: null, note: null }

describe('edgeActivity', () => {
  it('direction: towards the group while delegating, towards the Orchestrator while a reply passes, else the edge\'s own way', () => {
    expect(edgeActivity(live, ctx()).direction).toBe('forward')
    expect(edgeActivity(live, ctx({ delegating: true })).direction).toBe('toGroup')
    expect(edgeActivity(live, ctx({ firing: true })).direction).toBe('toOrchestrator')
    expect(edgeActivity(live, ctx({ delegating: true, firing: true })).direction).toBe('toGroup') // the delegation wins
    // without an Orchestrator: always source -> target
    expect(edgeActivity(live, ctx({ orchestrator: false, firing: true })).direction).toBe('forward')
    expect(edgeActivity(live, ctx({ orchestrator: false, delegating: true }))).toMatchObject({ direction: 'forward', speed: 'slow' })
  })

  it('speed: fast while the source end works or the edge fires or delegates, slow when idle, stopped by any pause', () => {
    expect(edgeActivity(live, ctx()).speed).toBe('slow')
    expect(edgeActivity(live, ctx({ source: ['idle', 'working'] })).speed).toBe('fast')
    expect(edgeActivity(live, ctx({ target: ['working'] })).speed).toBe('slow') // only the source end counts
    expect(edgeActivity(live, ctx({ source: ['waiting'] })).speed).toBe('slow')
    expect(edgeActivity(live, ctx({ firing: true })).speed).toBe('fast')
    expect(edgeActivity(live, ctx({ delegating: true })).speed).toBe('fast')
    expect(edgeActivity(live, ctx({ orchestrator: false, firing: true })).speed).toBe('fast')
    for (const stop of [{ flowsPaused: true }, { processesPaused: true }]) expect(edgeActivity(live, ctx({ ...stop, source: ['working'], firing: true }))).toMatchObject({ speed: 'stopped', tone: 'paused' })
    expect(edgeActivity({ paused: 'Loop detected', note: null }, ctx({ delegating: true }))).toEqual({ direction: 'toGroup', speed: 'stopped', tone: 'paused' })
  })

  it('tone: error for an agent in error at either end, a failed last run or a failed delegation; paused wins', () => {
    expect(edgeActivity(live, ctx()).tone).toBe('normal')
    expect(edgeActivity(live, ctx({ source: ['idle', 'error'] })).tone).toBe('error')
    expect(edgeActivity(live, ctx({ target: ['error'] })).tone).toBe('error')
    expect(edgeActivity({ paused: null, note: 'Zoe had no message to pass on' }, ctx()).tone).toBe('error')
    expect(edgeActivity(live, ctx({ taskFailed: true })).tone).toBe('error')
    expect(edgeActivity(live, ctx({ taskFailed: true, flowsPaused: true })).tone).toBe('paused')
    expect(edgeActivity(live, ctx({ source: ['exited'] })).tone).toBe('normal')
  })

  it('says the state in words', () => {
    expect(activityWords(edgeActivity(live, ctx({ delegating: true })))).toBe('delegating, running')
    expect(activityWords(edgeActivity(live, ctx({ firing: true })))).toBe('passing a reply, running')
    expect(activityWords(edgeActivity(live, ctx()))).toBe('resting')
    expect(activityWords(edgeActivity(live, ctx({ source: ['working'] })))).toBe('running')
    expect(activityWords(edgeActivity(live, ctx({ flowsPaused: true, target: ['error'] })))).toBe('paused')
    expect(activityWords(edgeActivity(live, ctx({ target: ['error'] })))).toBe('error, resting')
  })
})

describe('runnerPath', () => {
  const pts = [{ x: 10, y: 50 }, { x: 20, y: 40 }, { x: 30, y: 20 }, { x: 40, y: 60 }]
  it('N points -> N keyframes inside the bounding box, evenly spaced, fading in and out at the ends', () => {
    const { box, frames } = runnerPath(pts, false)
    expect(box).toEqual({ x: 10, y: 20, w: 30, h: 40 })
    expect(frames).toHaveLength(4)
    expect(frames.map((f) => f.transform)).toEqual(['translate(0.0px, 30.0px)', 'translate(10.0px, 20.0px)', 'translate(20.0px, 0.0px)', 'translate(30.0px, 40.0px)'])
    expect(frames.map((f) => f.offset)).toEqual([0, 1 / 3, 2 / 3, 1])
    expect(frames.map((f) => f.opacity)).toEqual([0, 1, 1, 0])
  })
  it('reversed for the opposite direction, same box and offsets', () => {
    const fwd = runnerPath(pts, false)
    const back = runnerPath(pts, true)
    expect(back.box).toEqual(fwd.box)
    expect(back.frames.map((f) => f.transform)).toEqual(fwd.frames.map((f) => f.transform).reverse())
    expect(back.frames.map((f) => f.offset)).toEqual(fwd.frames.map((f) => f.offset))
    expect(pts[0]).toEqual({ x: 10, y: 50 }) // the input is left alone
  })
})

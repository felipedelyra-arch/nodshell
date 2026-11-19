import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvas } from '../../src/renderer/store'

describe('toast priority', () => {
  beforeEach(() => useCanvas.setState({ toast: null }))
  it('a low-priority offer is dropped while a notice shows, and any notice replaces it at once', () => {
    const { notify } = useCanvas.getState()
    notify('Edge A to B paused. Loop.', 'error')
    notify('t printed http://localhost:3000', 'info', undefined, { low: true })
    expect(useCanvas.getState().toast?.text).toBe('Edge A to B paused. Loop.')
    useCanvas.setState({ toast: null })
    notify('t printed http://localhost:3000', 'info', undefined, { low: true })
    expect(useCanvas.getState().toast?.low).toBe(true)
    notify('Memory is low.', 'info')
    expect(useCanvas.getState().toast?.text).toBe('Memory is low.')
    notify('later offer', 'info', undefined, { low: true }) // still dropped: the notice is visible
    expect(useCanvas.getState().toast?.text).toBe('Memory is low.')
  })
})

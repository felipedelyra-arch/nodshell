import { describe, expect, it } from 'vitest'
import { snapShift } from '../../src/renderer/terminal/snap'

describe('snapShift', () => {
  it('lands the edge on a whole device pixel, moving at most half a device pixel', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const scale of [0.5, 1, 1.37]) {
        for (const pos of [0, 0.25, 0.5, 0.75, 100.6, 313.37, 1023.999]) {
          const shift = snapShift(pos, dpr, scale)
          const movedDevice = shift * scale * dpr // what the edge actually travels on screen, in device px
          expect(Math.abs(movedDevice)).toBeLessThanOrEqual(0.5 + 1e-9)
          const landed = pos * dpr + movedDevice
          expect(Math.abs(landed - Math.round(landed))).toBeLessThan(1e-9)
        }
      }
    }
  })

  it('does nothing when already aligned or when the inputs are unusable', () => {
    expect(snapShift(120, 1, 1)).toBeCloseTo(0)
    expect(snapShift(0.6, 0, 1)).toBe(0)
    expect(snapShift(0.6, 1, 0)).toBe(0)
    expect(snapShift(NaN, 1, 1)).toBe(0)
  })
})

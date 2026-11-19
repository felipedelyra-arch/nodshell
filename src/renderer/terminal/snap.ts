// Translate, in the element's own (pre-scale) CSS px, that moves an edge sitting at `cssPos` screen CSS px onto the nearest whole
// device pixel. `scale` is the net scale between the element's parent space and the screen (a 1 CSS px local move is `scale` screen px).
export function snapShift(cssPos: number, dpr: number, scale: number): number {
  if (!(dpr > 0) || !(scale > 0) || !Number.isFinite(cssPos)) return 0
  const device = cssPos * dpr
  return (Math.round(device) - device) / dpr / scale
}

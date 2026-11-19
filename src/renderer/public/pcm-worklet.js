/* global AudioWorkletProcessor, registerProcessor */
// AudioWorklet served as a file of the app itself (the CSP allows only 'self' scripts): hands each audio block to the page.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    // 'flush' -> 'done': messages on one port arrive in order, so the page has every block posted before the marker
    this.port.onmessage = (e) => e.data === 'flush' && this.port.postMessage('done')
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice())
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)

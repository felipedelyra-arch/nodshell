/** Raw PTY output kept per terminal for the scrape fallback. */
export const TAIL_MAX = 64 * 1024
const LINES = 40
const TEXT_MAX = 8000

/** Best effort: strips ANSI/OSC/control sequences from a raw PTY tail and returns its last non-empty lines (bounded). */
export function scrapeText(raw: string): string {
  /* eslint-disable no-control-regex -- stripping terminal control sequences is the point */
  const text = raw
    .slice(-TAIL_MAX)
    .replace(/\x1b\[\d*C/g, ' ') // cursor-forward is how TUIs draw spaces
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b[P^_][^\x1b]*(?:\x1b\\)?/g, '') // DCS, PM, APC
    .replace(/\x1b[ -/]*[0-~]?/g, '') // any other escape
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  /* eslint-enable no-control-regex */
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  return lines.slice(-LINES).join('\n').slice(-TEXT_MAX)
}

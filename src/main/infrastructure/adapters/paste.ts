import { PROMPT_MAX } from '../../../shared/agent'
import type { PromptPty, SubmitGuard } from '../../domain/adapter'
import { AgentError, HeldInput } from '../../domain/agent'

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
export const ENTER_DELAY_MS = 150

/** CRLF -> LF; drops ESC, every other C0 control except \n and \t, DEL and C1 (so the text cannot end the paste early); caps length. */
export function sanitizePrompt(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, PROMPT_MAX)
}

const queues = new Map<string, Promise<void>>()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Bracketed paste, then Enter after a short delay; serialized per PTY so two prompts never interleave. `guard` runs inside the
 * queue right before the paste and again before the Enter: a reason before the paste writes nothing (AgentError); after it, the
 * Enter is withheld and the text stays unsent in the input (HeldInput).
 */
export function submitBracketed(pty: PromptPty, text: string, delayMs = ENTER_DELAY_MS, guard?: SubmitGuard): Promise<void> {
  const clean = sanitizePrompt(text)
  if (!clean.trim()) return Promise.reject(new AgentError('Empty prompt'))
  if (!pty.alive()) return Promise.reject(new AgentError('Agent is not running'))
  const run = (queues.get(pty.key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (!pty.alive()) throw new AgentError('Agent is not running')
    const before = guard?.()
    if (before) throw new AgentError(before)
    pty.write(PASTE_START + clean + PASTE_END)
    await sleep(delayMs)
    if (!pty.alive()) throw new AgentError('Agent is not running')
    const after = guard?.()
    if (after) throw new HeldInput(`${after}, the text was left unsent in its input`)
    pty.write('\r')
  })
  queues.set(pty.key, run)
  const drop = () => void (queues.get(pty.key) === run && queues.delete(pty.key))
  run.then(drop, drop)
  return run
}

// Pure agent state machine: no Electron, no fs. Adapters translate their own signals into these transitions.
import type { AgentState } from './adapter'

/**
 * ready: session usable · prompt: a turn started · stop: the turn ended (normally or on an API error) · needs-input: blocked on the user ·
 * resumed: unblocked (e.g. a tool ran after approval) · at-input: the CLI reports it sits at its input (covers an interrupted turn, which has no Stop)
 */
export type Transition = 'ready' | 'prompt' | 'stop' | 'needs-input' | 'resumed' | 'at-input' | { exit: number }

export function nextState(cur: AgentState, t: Transition | null): AgentState {
  // the process is gone: late or duplicate events can never revive it
  if (cur === 'exited' || cur === 'error' || t === null) return cur
  if (typeof t === 'object') return t.exit === 0 ? 'exited' : 'error'
  switch (t) {
    case 'ready':
      return cur === 'starting' ? 'idle' : cur // a second session start (/clear, compaction) mid-turn changes nothing
    case 'prompt':
      return 'working'
    case 'stop':
      return 'idle'
    case 'needs-input':
      return cur === 'working' ? 'waiting' : cur // a request for input only makes sense inside a turn
    case 'resumed':
      return cur === 'waiting' ? 'working' : cur // never turns an idle agent busy (e.g. a late tool event after Stop)
    case 'at-input':
      return cur === 'working' || cur === 'waiting' ? 'idle' : cur
  }
}

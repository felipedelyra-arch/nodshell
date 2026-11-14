import { z } from 'zod'
import type { HookSignal } from '../../domain/adapter'

/** One line per connection, `{token, event}\n`; anything longer is dropped unread. */
export const MAX_LINE = 64 * 1024
/** The hook events the app injects (see settings.ts). */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'PostToolUse'] as const
/** The only fields the relay forwards: never the prompt, the reply or tool data. */
export const RELAYED_FIELDS = ['hook_event_name', 'session_id', 'transcript_path', 'notification_type'] as const

export const envelopeSchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/), event: z.unknown() })

// Unknown fields are tolerated (stripped); the ones the state machine relies on are enforced.
const common = {
  session_id: z.uuid(),
  transcript_path: z.string().min(1).max(4096).optional(),
}
export const hookEventSchema = z.discriminatedUnion('hook_event_name', [
  z.object({ hook_event_name: z.literal('SessionStart'), ...common }),
  z.object({ hook_event_name: z.literal('UserPromptSubmit'), ...common }),
  z.object({ hook_event_name: z.literal('Stop'), ...common }),
  z.object({ hook_event_name: z.literal('StopFailure'), ...common }),
  z.object({ hook_event_name: z.literal('PostToolUse'), ...common }),
  z.object({ hook_event_name: z.literal('Notification'), ...common, notification_type: z.string().min(1).max(64) }),
])

export type HookEvent = z.infer<typeof hookEventSchema>

export function toSignal(e: HookEvent): HookSignal {
  return {
    type: 'hook',
    event: e.hook_event_name,
    sessionId: e.session_id,
    transcriptPath: e.transcript_path,
    notificationType: e.hook_event_name === 'Notification' ? e.notification_type : undefined,
  }
}

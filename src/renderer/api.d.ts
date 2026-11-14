import type { ChannelInput, ChannelName, ChannelOutput, EventName, EventPayload } from '../shared/ipc/channels'

declare global {
  interface Window {
    api: {
      invoke<C extends ChannelName>(channel: C, payload: ChannelInput<C>): Promise<ChannelOutput<C>>
      on<E extends EventName>(event: E, callback: (payload: EventPayload<E>) => void): () => void
    }
  }
}

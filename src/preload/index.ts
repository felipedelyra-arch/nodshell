import { contextBridge, ipcRenderer } from 'electron'
import { channelNames, eventNames } from '../shared/ipc/names'
import type { ChannelInput, ChannelName, ChannelOutput, EventName, EventPayload } from '../shared/ipc/channels'

contextBridge.exposeInMainWorld('api', {
  invoke: <C extends ChannelName>(channel: C, payload: ChannelInput<C>): Promise<ChannelOutput<C>> => {
    if (!(channelNames as readonly string[]).includes(channel)) return Promise.reject(new Error('Unknown channel'))
    return ipcRenderer.invoke(channel, payload) as Promise<ChannelOutput<C>>
  },
  // The callback only ever receives the payload, never the IPC event object.
  on: <E extends EventName>(event: E, callback: (payload: EventPayload<E>) => void): (() => void) => {
    if (!(eventNames as readonly string[]).includes(event)) throw new Error('Unknown event')
    const listener = (_e: unknown, payload: EventPayload<E>) => callback(payload)
    ipcRenderer.on(event, listener)
    return () => void ipcRenderer.removeListener(event, listener)
  },
})

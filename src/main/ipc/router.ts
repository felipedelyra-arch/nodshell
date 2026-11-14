import { ipcMain } from 'electron'
import type { ZodType } from 'zod'
import { channels, type ChannelInput, type ChannelName, type ChannelOutput } from '../../shared/ipc/channels'
import { isAllowedNavigation } from '../security'
import { isTileContents } from '../infrastructure/webtiles'
import { IpcError, runValidated } from './validate'

type Schemas<C extends ChannelName> = {
  in: ZodType<ChannelInput<C>>
  out: ZodType<ChannelOutput<C>>
}

/** `senderId` is the webContents id of the caller, used for ownership checks. */
export type Ctx = { senderId: number }

export function handle<C extends ChannelName>(
  channel: C,
  appOrigin: string,
  handler: (input: ChannelInput<C>, ctx: Ctx) => ChannelOutput<C> | Promise<ChannelOutput<C>>,
): void {
  ipcMain.handle(channel, (event, raw: unknown) => {
    const url = event.senderFrame?.url ?? ''
    // a web tile has no preload and so no way to call; refused anyway (in dev it could even sit at the app's own origin)
    if (isTileContents(event.sender) || !isAllowedNavigation(url, appOrigin)) throw new IpcError('Forbidden')
    return runValidated(channels[channel] as unknown as Schemas<C>, (input) => handler(input, { senderId: event.sender.id }), raw)
  })
}

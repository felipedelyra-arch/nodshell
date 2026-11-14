import { create } from 'zustand'
import type { ChannelInput, ChannelOutput } from '../../shared/ipc/channels'
import { remoteMessage } from '../store'

export type PresetDto = ChannelOutput<'preset:list'>['presets'][number]
export type PresetSave = ChannelInput<'preset:save'>

type State = {
  presets: PresetDto[]
  load: () => Promise<void>
  /** resolve to an error message, or null on success */
  save: (p: PresetSave) => Promise<string | null>
  remove: (id: string) => Promise<string | null>
}

export const usePresets = create<State>((set, get) => ({
  presets: [],
  load: async () => {
    try {
      set({ presets: (await window.api.invoke('preset:list', undefined)).presets })
    } catch {
      set({ presets: [] })
    }
  },
  save: async (p) => {
    try {
      await window.api.invoke('preset:save', p)
      await get().load()
      return null
    } catch (e) {
      return remoteMessage(e, 'Could not save the preset.')
    }
  },
  remove: async (id) => {
    try {
      await window.api.invoke('preset:delete', { id })
      await get().load()
      return null
    } catch (e) {
      return remoteMessage(e, 'Could not delete the preset.')
    }
  },
}))

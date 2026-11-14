import * as pty from 'node-pty'
import type { SpawnPty } from './manager'

// Kept apart from the manager so unit tests never load the native module.
export const spawnNodePty: SpawnPty = (file, args, opts) => pty.spawn(file, args, { name: 'xterm-256color', ...opts })

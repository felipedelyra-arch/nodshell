import { writeFile } from 'node:fs'
import * as pty from 'node-pty'
import type { SpawnPty } from './manager'

// Kept apart from the manager so unit tests never load the native module.
export const spawnNodePty: SpawnPty = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: 'xterm-256color', ...opts })
  // when memory runs out, the kernel (or earlyoom) should end a terminal's processes, not the desktop or the app (Linux; best effort)
  writeFile(`/proc/${p.pid}/oom_score_adj`, '500', () => undefined)
  return p
}

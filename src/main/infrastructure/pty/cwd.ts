import { realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'

export type Fs = { realpathSync: (p: string) => string; statSync: (p: string) => { isDirectory(): boolean } }

/** Returns the real path of `candidate` if it is an existing directory inside an allowed root; throws otherwise. */
export function validateCwd(candidate: string, allowedRoots: string[], fs: Fs = { realpathSync, statSync }): string {
  let real: string
  try {
    real = fs.realpathSync(candidate)
    if (!fs.statSync(real).isDirectory()) throw new Error()
  } catch {
    throw new Error('Invalid working directory')
  }
  for (const root of allowedRoots) {
    let realRoot: string
    try {
      realRoot = fs.realpathSync(root)
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real
  }
  throw new Error('Invalid working directory')
}

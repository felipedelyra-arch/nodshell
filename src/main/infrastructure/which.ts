import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Absolute path of the first executable regular file named `name` on PATH; relative PATH entries are ignored. */
export function which(name: string, pathVar: string | undefined): string | undefined {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return undefined
  for (const dir of (pathVar ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // not here
    }
  }
  return undefined
}

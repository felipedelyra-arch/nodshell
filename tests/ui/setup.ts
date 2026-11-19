import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { OUT, PREFIX } from './support'

/** Starts each run from an empty set of this prefix (other prefixes in the same directory are left alone). */
export default function setup(): void {
  mkdirSync(OUT, { recursive: true })
  for (const f of readdirSync(OUT)) if (f.startsWith(`${PREFIX}-`)) rmSync(join(OUT, f), { force: true })
}

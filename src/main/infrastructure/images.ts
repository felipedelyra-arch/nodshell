import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMAGE_MAX_BYTES } from '../../shared/annotation'
import { IMAGE_EXTS, ImageError, sniffImage, type ImageInfo } from '../domain/image'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILE_RE = new RegExp(`^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.(${IMAGE_EXTS.join('|')})$`, 'i')

/** The stored file of an image id, or null: only a UUID is accepted, so the result can never leave `dir`. */
export function imageFile(dir: string, id: string): string | null {
  if (!UUID_RE.test(id)) return null
  const lower = id.toLowerCase()
  for (const ext of IMAGE_EXTS) {
    const f = join(dir, `${lower}.${ext}`)
    if (existsSync(f)) return f
  }
  return null
}

/** The file the user picked, at most IMAGE_MAX_BYTES (reads one byte more to tell); a regular file only. */
export function readPicked(file: string): Buffer {
  // non-blocking open: a FIFO without a writer must be refused, not wait forever
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new ImageError('Not a valid PNG, JPEG, WebP or GIF image')
    const buf = Buffer.alloc(IMAGE_MAX_BYTES + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > IMAGE_MAX_BYTES) throw new ImageError('Image is larger than 5 MB')
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** Validated copies of board images: one file per image (uuid + the extension of the validated type), directory 0700, files 0600. */
export class ImageStore {
  constructor(readonly dir: string) {}

  /** Validates the bytes (type from the content, size, dimensions) and stores a copy. */
  add(bytes: Uint8Array): { id: string; width: number; height: number } {
    const info = sniffImage(bytes)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
    const id = randomUUID()
    writeFileSync(join(this.dir, `${id}.${info.ext}`), bytes, { mode: 0o600, flag: 'wx' })
    return { id, width: info.width, height: info.height }
  }

  has(id: string): boolean {
    return imageFile(this.dir, id) !== null
  }

  /** The bytes with the type read from them again (what is served is what the bytes are), or null. */
  async read(id: string): Promise<{ data: Buffer; info: ImageInfo } | null> {
    const f = imageFile(this.dir, id)
    if (!f) return null
    try {
      const data = await readFile(f)
      return { data, info: sniffImage(data) }
    } catch {
      return null
    }
  }

  remove(ids: Iterable<string>): void {
    for (const id of ids) {
      const f = imageFile(this.dir, id)
      if (f) unlinkSync(f)
    }
  }

  /** Deletes every image file whose id is not in `keep`; returns how many went. */
  cleanup(keep: ReadonlySet<string>): number {
    if (!existsSync(this.dir)) return 0
    let n = 0
    for (const name of readdirSync(this.dir)) {
      const m = FILE_RE.exec(name)
      if (!m || keep.has(m[1]!.toLowerCase())) continue
      try {
        unlinkSync(join(this.dir, name))
        n++
      } catch {
        // left for the next start
      }
    }
    return n
  }
}

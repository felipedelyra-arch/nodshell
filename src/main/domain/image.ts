// Pure image validation: the type comes from the bytes, never from a name; SVG and everything else is refused. No Electron, no fs.
import { IMAGE_DIM_MAX, IMAGE_MAX_BYTES } from '../../shared/annotation'

export type ImageType = 'png' | 'jpeg' | 'webp' | 'gif'
export type ImageInfo = { type: ImageType; ext: string; mime: string; width: number; height: number }
/** The messages reach the user as they are: short, no path. */
export class ImageError extends Error {}

const TYPES: Record<ImageType, { ext: string; mime: string }> = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
  gif: { ext: 'gif', mime: 'image/gif' },
}
export const IMAGE_EXTS = Object.values(TYPES).map((t) => t.ext)

const ascii = (b: Uint8Array, at: number, s: string) => b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0))
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const le16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)

/** [width, height] from the PNG header; the file must also end with IEND (a cut file is refused). */
function png(b: Uint8Array): [number, number] | null {
  if (b.length < 45 || !ascii(b, 12, 'IHDR') || be32(b, 8) !== 13) return null
  if (!ascii(b, b.length - 8, 'IEND')) return null
  return [be32(b, 16), be32(b, 20)]
}

/** [width, height] from the first SOF segment; the file must end with EOI. */
function jpeg(b: Uint8Array): [number, number] | null {
  let end = b.length
  while (end > 2 && b[end - 1] === 0) end-- // some writers pad
  if (b[end - 2] !== 0xff || b[end - 1] !== 0xd9) return null
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]!
    if (m === 0xff) {
      i++
      continue
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 9 <= b.length ? [(b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!] : null
    if (m === 0xda) return null // image data before any frame header
    i += 2 + ((b[i + 2]! << 8) | b[i + 3]!)
  }
  return null
}

function gif(b: Uint8Array): [number, number] | null {
  if (b.length < 14 || b[b.length - 1] !== 0x3b) return null
  return [le16(b, 6), le16(b, 8)]
}

function webp(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null
  if (((b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) >>> 0) + 8 > b.length) return null // the declared size is more than there is: cut
  if (ascii(b, 12, 'VP8X')) return [le24(b, 24) + 1, le24(b, 27) + 1]
  if (ascii(b, 12, 'VP8L')) return b[20] === 0x2f ? [1 + (b[21]! | ((b[22]! & 0x3f) << 8)), 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10))] : null
  if (ascii(b, 12, 'VP8 ')) return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff] : null
  return null
}

/** The type and size of a PNG, JPEG, WebP or GIF, read from its bytes. Throws ImageError for anything else, a cut file, too big a file or absurd dimensions. */
export function sniffImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length > IMAGE_MAX_BYTES) throw new ImageError('Image is larger than 5 MB')
  let type: ImageType | null = null
  let dims: [number, number] | null = null
  if (bytes[0] === 0x89 && ascii(bytes, 1, 'PNG\r\n\x1a\n')) [type, dims] = ['png', png(bytes)]
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) [type, dims] = ['jpeg', jpeg(bytes)]
  else if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) [type, dims] = ['gif', gif(bytes)]
  else if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) [type, dims] = ['webp', webp(bytes)]
  if (!type || !dims) throw new ImageError('Not a valid PNG, JPEG, WebP or GIF image')
  const [width, height] = dims
  if (width < 1 || height < 1) throw new ImageError('Not a valid PNG, JPEG, WebP or GIF image')
  if (width > IMAGE_DIM_MAX || height > IMAGE_DIM_MAX) throw new ImageError(`Image is larger than ${IMAGE_DIM_MAX} px`)
  return { type, ...TYPES[type], width, height }
}

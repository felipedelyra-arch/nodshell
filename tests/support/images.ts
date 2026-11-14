import { crc32, deflateSync } from 'node:zlib'

const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const le16 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255])
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  return Buffer.concat([be32(data.length), body, be32(crc32(body))])
}

/** A real, decodable PNG filled with one colour. */
export function png(w: number, h: number, rgb: [number, number, number] = [255, 106, 43]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const ihdr = Buffer.concat([be32(w), be32(h), Buffer.from([8, 2, 0, 0, 0])])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Header-only JPEG (SOI, one SOF0, EOI): enough for type and size checks, not decodable. */
export function jpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), sof, Buffer.from([0xff, 0xd9])])
}

export function gif(w: number, h: number): Buffer {
  return Buffer.concat([Buffer.from('GIF89a', 'ascii'), le16(w), le16(h), Buffer.from([0, 0, 0, 0x3b])])
}

const riff = (fourcc: string, payload: Buffer) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), Buffer.from(fourcc, 'ascii'), Buffer.from([payload.length & 255, (payload.length >> 8) & 255, 0, 0]), payload])
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0]), body])
}
/** Header-only WebP in the three layouts (extended, lossless, lossy). */
export function webp(w: number, h: number, kind: 'VP8X' | 'VP8L' | 'VP8 ' = 'VP8X'): Buffer {
  if (kind === 'VP8X') {
    const px = (n: number) => Buffer.from([(n - 1) & 255, ((n - 1) >> 8) & 255, ((n - 1) >> 16) & 255])
    return riff('VP8X', Buffer.concat([Buffer.alloc(4), px(w), px(h)]))
  }
  if (kind === 'VP8L') {
    const bits = (w - 1) | ((h - 1) << 14)
    return riff('VP8L', Buffer.from([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255, 0, 0, 0, 0, 0, 0, 0]))
  }
  return riff('VP8 ', Buffer.concat([Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]), le16(w), le16(h), Buffer.alloc(8)]))
}

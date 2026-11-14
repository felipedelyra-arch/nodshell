import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES } from '../../src/shared/annotation'
import { ImageError, sniffImage } from '../../src/main/domain/image'
import { ImageStore, imageFile, readPicked } from '../../src/main/infrastructure/images'
import { gif, jpeg, png, webp } from '../support/images'

const refused = (b: Uint8Array) => expect(() => sniffImage(b)).toThrow(ImageError)

describe('sniffImage', () => {
  it('reads type and size from the bytes of PNG, JPEG, GIF and the three WebP layouts', () => {
    expect(sniffImage(png(40, 30))).toMatchObject({ type: 'png', ext: 'png', mime: 'image/png', width: 40, height: 30 })
    expect(sniffImage(jpeg(640, 480))).toMatchObject({ type: 'jpeg', ext: 'jpg', mime: 'image/jpeg', width: 640, height: 480 })
    expect(sniffImage(gif(16, 9))).toMatchObject({ type: 'gif', mime: 'image/gif', width: 16, height: 9 })
    for (const kind of ['VP8X', 'VP8L', 'VP8 '] as const) expect(sniffImage(webp(300, 200, kind))).toMatchObject({ type: 'webp', mime: 'image/webp', width: 300, height: 200 })
  })
  it('refuses SVG, HTML, text and empty input whatever it claims to be', () => {
    refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'))
    refused(Buffer.from('<!doctype html><img src=x onerror=alert(1)>'))
    refused(Buffer.from('GIF89 not really'))
    refused(Buffer.alloc(0))
    refused(Buffer.from('plain text'))
  })
  it('refuses a cut file', () => {
    refused(png(40, 30).subarray(0, 30))
    refused(png(40, 30).subarray(0, -12)) // IEND gone
    refused(jpeg(64, 64).subarray(0, -2)) // EOI gone
    refused(gif(8, 8).subarray(0, -1))
    refused(webp(8, 8).subarray(0, -4)) // fewer bytes than the RIFF size says
  })
  it('refuses absurd or zero dimensions and files over 5 MB', () => {
    refused(png(8193, 10))
    refused(png(10, 8193))
    refused(jpeg(9000, 100))
    refused(gif(0, 5))
    refused(webp(20000, 20000))
    expect(sniffImage(png(8192, 1)).width).toBe(8192)
    const big = Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_MAX_BYTES)])
    expect(() => sniffImage(big)).toThrow(/5 MB/)
  })
})

describe('ImageStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodshell-img-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stores a validated copy named by a uuid and the validated type, with private modes', async () => {
    const store = new ImageStore(join(dir, 'board-images'))
    const { id, width, height } = store.add(png(20, 10))
    expect([width, height]).toEqual([20, 10])
    expect(readdirSync(store.dir)).toEqual([`${id}.png`])
    expect(statSync(store.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(store.dir, `${id}.png`)).mode & 0o777).toBe(0o600)
    const back = (await store.read(id))!
    expect(back.info.mime).toBe('image/png')
    expect(back.data.equals(png(20, 10))).toBe(true)
  })
  it('refuses an SVG saved with a .png name: the file name never matters, only the bytes', () => {
    const file = join(dir, 'cat.png')
    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const store = new ImageStore(join(dir, 'board-images'))
    expect(() => store.add(readPicked(file))).toThrow(ImageError)
    expect(readdirSync(dir)).not.toContain('board-images') // nothing was stored
  })
  it('readPicked refuses files over 5 MB and anything that is not a regular file', () => {
    const big = join(dir, 'big.png')
    writeFileSync(big, Buffer.alloc(IMAGE_MAX_BYTES + 1))
    expect(() => readPicked(big)).toThrow(/5 MB/)
    expect(() => readPicked(dir)).toThrow(ImageError)
  })
  it('readPicked refuses a FIFO at once instead of blocking on it', () => {
    const fifo = join(dir, 'pipe.png')
    execFileSync('mkfifo', [fifo])
    expect(() => readPicked(fifo)).toThrow(ImageError)
  })
  it('resolves an id only inside its directory: traversal and malformed ids find nothing', async () => {
    const store = new ImageStore(join(dir, 'board-images'))
    const { id } = store.add(png(4, 4))
    writeFileSync(join(dir, 'secret.png'), png(4, 4))
    expect(imageFile(store.dir, id)).toBe(join(store.dir, `${id}.png`))
    expect(imageFile(store.dir, id.toUpperCase())).toBe(join(store.dir, `${id}.png`))
    for (const bad of ['../secret', '..%2fsecret', `${id}/../../secret`, `${id}.png`, `${id}\0`, '', 'not-a-uuid', '/etc/passwd', `../${id}`, '00000000-0000-4000-8000-000000000000']) {
      expect(imageFile(store.dir, bad), bad).toBeNull()
      expect(await store.read(bad), bad).toBeNull()
    }
  })
  it('removes images and cleans up the files nothing refers to', () => {
    const store = new ImageStore(join(dir, 'board-images'))
    const a = store.add(png(4, 4)).id
    const b = store.add(png(5, 5)).id
    const c = store.add(png(6, 6)).id
    writeFileSync(join(store.dir, 'notes.txt'), 'left alone')
    expect(store.cleanup(new Set([b]))).toBe(2)
    expect(store.has(a)).toBe(false)
    expect(store.has(b)).toBe(true)
    expect(store.has(c)).toBe(false)
    expect(readdirSync(store.dir).sort()).toEqual([`${b}.png`, 'notes.txt'])
    store.remove([b, b])
    expect(store.has(b)).toBe(false)
    mkdirSync(join(dir, 'x'))
    expect(new ImageStore(join(dir, 'nowhere')).cleanup(new Set())).toBe(0)
  })
})

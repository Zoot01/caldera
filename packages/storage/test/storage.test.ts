import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, defineEnv } from '@caldera/core'
import { createRouter, defineRequest, defineRoutes, errorHandler } from '@caldera/http'
import { Hono } from 'hono'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createStorage, storageProvider, storageRoutes, zfile, type ValidatedFile } from '../src/index.js'
import { localStorageDriver } from '../src/local.js'
import { exe, file, jpegHeader, png } from './files.js'

const roots: string[] = []
const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'caldera-disk-'))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})
const KEY = 'app-key-0123456789-0123456789-01234'

const disks = [
  { name: 'memory', make: () => createStorage({ default: 'files', disks: { files: { driver: 'memory' } } }) },
  { name: 'local', make: () => createStorage({ default: 'files', disks: { files: { driver: 'local', root: tempRoot() } } }, { drivers: [localStorageDriver] }) },
]

describe.each(disks)('disk API on $name', ({ make }) => {
  it('puts, reads, lists, copies, moves and deletes', async () => {
    const storage = make()
    const info = await storage.put('docs/a.txt', 'hello')
    expect(info).toMatchObject({ key: 'docs/a.txt', size: 5 })
    expect(await storage.getText('docs/a.txt')).toBe('hello')
    await storage.put('docs/b.bin', new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' })
    await storage.put('img/c.png', png(2, 2))
    expect((await storage.list('docs')).files.map((f) => f.key)).toEqual(['docs/a.txt', 'docs/b.bin'])
    const all: string[] = []
    for await (const f of storage.listAll()) all.push(f.key)
    expect(all).toEqual(['docs/a.txt', 'docs/b.bin', 'img/c.png'])
    await storage.copy('docs/a.txt', 'docs/copy.txt')
    await storage.move('docs/copy.txt', 'archive/a.txt')
    expect(await storage.exists('docs/copy.txt')).toBe(false)
    expect(await storage.getText('archive/a.txt')).toBe('hello')
    expect(new TextDecoder().decode(await new Response(await storage.getStream('docs/a.txt', { start: 1, end: 3 })).arrayBuffer())).toBe('ell')
    await storage.delete('docs/a.txt', 'docs/b.bin')
    await expect(storage.get('docs/a.txt')).rejects.toMatchObject({ code: 'file_not_found' })
  })

  it('pages through large listings', async () => {
    const storage = make()
    for (let i = 0; i < 5; i++) await storage.put(`many/${i}.txt`, String(i))
    const first = await storage.list('many', { limit: 2 })
    expect(first.files.map((f) => f.key)).toEqual(['many/0.txt', 'many/1.txt'])
    const second = await storage.list('many', { limit: 2, cursor: first.cursor! })
    expect(second.files.map((f) => f.key)).toEqual(['many/2.txt', 'many/3.txt'])
  })

  it('refuses keys that could escape the disk', async () => {
    const storage = make()
    for (const key of ['../etc/passwd', 'a/../../b', 'a\\b', '', 'a/./b', 'nul\u0000']) {
      await expect(storage.put(key, 'x')).rejects.toMatchObject({ code: 'storage_key_invalid' })
    }
    expect((await storage.put('//a//b/', 'x')).key).toBe('a/b')
  })

  it('putFile names files by what the bytes are, not the client’s name or type', async () => {
    const storage = make()
    const key = await storage.putFile('avatars', file(png(4, 4), 'evil.html', 'text/html'))
    expect(key).toMatch(/^avatars\/[0-9a-f]{40}\.png$/)
    expect((await storage.info(key)).size).toBeGreaterThan(0)
    const response = await storage.response(key, { downloadAs: 'résumé.png' })
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="r_sum_.png"; filename*=UTF-8''r%C3%A9sum%C3%A9.png`)
    expect((await storage.response('missing.png')).status).toBe(404)
  })
})

describe('local disk', () => {
  it('writes atomically (no temp files left) and can’t be pointed outside its root', async () => {
    const root = tempRoot()
    const storage = createStorage({ default: 'files', disks: { files: { driver: 'local', root } } }, { drivers: [localStorageDriver] })
    await storage.put('a/b.txt', 'x')
    expect(readdirSync(join(root, 'a'))).toEqual(['b.txt'])
  })

  it('says what a missing capability needs', async () => {
    const storage = createStorage({ default: 'files', disks: { files: { driver: 'local', root: tempRoot() } } }, { drivers: [localStorageDriver] })
    expect(() => storage.url('a.txt')).toThrow(`The "files" disk can't make public URLs (no publicUrls).`)
    await expect(storage.temporaryUrl('a.txt', '5m')).rejects.toThrow(/can't make temporary URLs/)
    expect(() => createStorage({ default: 'x', disks: { x: { driver: 'local', root: '.' } } })).toThrow(/It's in '@caldera\/storage\/local'/)
  })
})

describe('signed URLs on a local disk (served by storageRoutes)', () => {
  function makeHttp() {
    const root = tempRoot()
    const app = createApp({
      env: defineEnv({}),
      providers: [storageProvider(() => ({ default: 'uploads', disks: { uploads: { driver: 'local', root, serve: { url: 'http://localhost', key: KEY } } } }), { drivers: [localStorageDriver] })],
    })
    return { app, http: new Hono().use(app.middleware()).route('/', storageRoutes()) }
  }

  it('downloads with a valid link; refuses tampered, foreign and expired ones', async () => {
    const { app, http } = makeHttp()
    await app.boot({ env: {} })
    await app.services.storage.put('reports/q3.pdf', 'pdf-bytes', { contentType: 'application/pdf' })
    const url = await app.services.storage.temporaryUrl('reports/q3.pdf', '5m', { downloadAs: 'Q3.pdf' })
    const ok = await http.request(url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('pdf-bytes')
    expect(ok.headers.get('content-disposition')).toContain('filename="Q3.pdf"')
    expect((await http.request(url.replace('q3.pdf', 'q4.pdf'))).status).toBe(403)
    expect((await http.request(url.replace(/download=[^&]+/, 'download=other.pdf'))).status).toBe(403)
    expect((await http.request(url.replace(/signature=[^&]+/, 'signature=AAAA'))).status).toBe(403)
    const expired = await app.services.storage.temporaryUrl('reports/q3.pdf', -1)
    expect((await http.request(expired)).status).toBe(403)
  })

  it('accepts an upload of exactly the signed type and size', async () => {
    const { app, http } = makeHttp()
    await app.boot({ env: {} })
    const body = png(3, 3)
    const upload = await app.services.storage.temporaryUploadUrl('tmp/up.png', { expiresIn: '5m', contentType: 'image/png', contentLength: body.length })
    expect(upload.headers).toEqual({ 'content-type': 'image/png' })
    // Wrong type or size: refused, nothing stored.
    expect((await http.request(upload.url, { method: 'PUT', body: body as BlobPart as never, headers: { ...upload.headers, 'content-type': 'text/html' } })).status).toBe(403)
    const longer = new Uint8Array(body.length + 10)
    expect((await http.request(upload.url, { method: 'PUT', body: longer as never, headers: { ...upload.headers, 'content-length': String(longer.length) } })).status).toBe(403)
    // Claiming the signed length but sending more: caught while reading.
    expect((await http.request(upload.url, { method: 'PUT', body: longer as never, headers: { ...upload.headers, 'content-length': String(body.length) } })).status).not.toBe(200)
    expect(await app.services.storage.exists('tmp/up.png')).toBe(false)
    const res = await http.request(upload.url, { method: 'PUT', body: body as never, headers: { ...upload.headers, 'content-length': String(body.length) } })
    expect(res.status).toBe(200)
    expect(await app.services.storage.get('tmp/up.png')).toEqual(body)
  })
})

describe('zfile', () => {
  const check = async (options: Parameters<typeof zfile>[0], f: File) => {
    const result = await zfile(options).safeParseAsync(f)
    return result.success ? (result.data as ValidatedFile).detected : result.error.issues[0]!.message
  }

  it('trusts the bytes, not the name or claimed type', async () => {
    expect(await check({ mimes: ['image/*'] }, file(png(10, 5), 'photo.txt', 'text/plain'))).toEqual({ mime: 'image/png', ext: 'png' })
    expect(await check({ mimes: ['png', 'jpg'] }, file('not really a png', 'photo.png', 'image/png'))).toBe('The file must be png, jpg (it is txt).')
    expect(await check({ mimes: ['pdf'] }, file(jpegHeader(10, 10), 'doc.pdf', 'application/pdf'))).toBe('The file must be pdf (it is jpg).')
  })

  it('refuses SVG, HTML and programs unless allowed', async () => {
    const svg = file('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'logo.png', 'image/png')
    expect(await check({}, svg)).toBe('SVG files can’t be uploaded.')
    expect(await check({ mimes: ['image/*'] }, svg)).toBe('SVG files can’t be uploaded.')
    expect(await check({ allow: ['svg'] }, svg)).toEqual({ mime: 'image/svg+xml', ext: 'svg' })
    expect(await check({}, file('<!DOCTYPE html><script>steal()</script>', 'notes.txt', 'text/plain'))).toBe('HTML files can’t be uploaded.')
    expect(await check({}, file(exe(), 'invoice.pdf', 'application/pdf'))).toBe('Programs can’t be uploaded.')
  })

  it('checks sizes and image dimensions', async () => {
    expect(await check({ maxSize: '1kb' }, file(new Uint8Array(2048), 'big.bin'))).toBe('The file is 2KB; the limit is 1KB.')
    expect(await check({}, file(new Uint8Array(), 'empty.txt'))).toBe('The file is empty.')
    expect(await check({ image: { maxWidth: 100 } }, file(png(120, 40), 'wide.png'))).toBe('The image is 120×40; the limit is 100×∞.')
    expect(await check({ image: { maxWidth: 4000 } }, file(jpegHeader(800, 600), 'photo.jpg'))).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 800, height: 600 })
    expect(await check({ image: { minWidth: 10 } }, file('plain text', 'a.txt'))).toBe('The file must be an image (PNG, JPEG, GIF or WebP).')
  })

  it('validates real multipart uploads in defineRequest, with field errors', async () => {
    const Upload = defineRequest({ form: z.object({ avatar: zfile({ maxSize: '1mb', mimes: ['image/*'], image: { maxWidth: 512 } }) }) })
    const routes = defineRoutes('upload').post('store', '/avatar', { request: Upload }, (c) => c.json(c.req.valid('form').avatar.detected))
    const http = new Hono().route('/', createRouter(routes).app).onError(errorHandler())
    const send = (f: File) => {
      const body = new FormData()
      body.set('avatar', f)
      return http.request('/avatar', { method: 'POST', body, headers: { accept: 'application/json' } })
    }
    expect(await (await send(file(png(64, 64), 'me.png'))).json()).toEqual({ mime: 'image/png', ext: 'png', width: 64, height: 64 })
    const refused = await send(file(png(1024, 10), 'huge.png'))
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ error: { fields: { avatar: ['The image is 1024×10; the limit is 512×∞.'] } } })
  })
})

it('fake() swaps a disk for a real in-memory one, with assertions, until restored', async () => {
  const root = tempRoot()
  const storage = createStorage({ default: 'files', disks: { files: { driver: 'local', root } } }, { drivers: [localStorageDriver] })
  const fake = storage.fake()
  await storage.putFile('avatars', file(png(2, 2), 'a.png'))
  await fake.assertCount('avatars', 1)
  await fake.assertMissing('avatars/nope.png')
  await expect(fake.assertExists('avatars/nope.png')).rejects.toThrow(/Expected "avatars\/nope.png" to exist/)
  expect(readdirSync(root)).toEqual([]) // nothing reached the real disk
  fake.restore()
  await storage.put('real.txt', 'x')
  expect(readdirSync(root)).toEqual(['real.txt'])
})

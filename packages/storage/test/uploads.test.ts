import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { createApp, defineEnv } from '@caldera/core'
import { createDatabase, defineModel, setDefaultDatabase } from '@caldera/db'
import { zjson } from '@caldera/db/sqlite'
import { defineRelations, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { integer, snakeCase, text } from 'drizzle-orm/sqlite-core'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanupFiles, createStorage, defineUpload, fileRef, fileResponse, pruneUploads, setDefaultStorage, storageProvider, storageRoutes, uploadRoutes, zupload, type FileRef, type SignedFileRef } from '../src/index.js'
import { localStorageDriver } from '../src/local.js'
import { s3StorageDriver } from '../src/s3.js'
import { png } from './files.js'
import { hasDocker, S3_CREDENTIALS, startS3 } from './s3-server.js'

const KEY = 'app-key-0123456789-0123456789-01234'
const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'caldera-up-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const avatar = defineUpload('avatar', { rules: { maxSize: '1mb', mimes: ['image/*'], image: { maxWidth: 512 } }, directory: 'avatars', authorize: (c) => c.req.header('x-user') !== 'banned' })

function makeHttp(disk: { driver: string; [k: string]: unknown }, drivers = [localStorageDriver]) {
  const app = createApp({ env: defineEnv({}), providers: [storageProvider(() => ({ default: 'files', disks: { files: disk }, uploadSecret: KEY }), { drivers })] })
  const http = new Hono()
    .use(app.middleware())
    .use(async (c, next) => {
      const user = c.req.header('x-user')
      c.set('user' as never, (user ? { id: user } : null) as never)
      await next()
    })
    .route('/', uploadRoutes({ uploads: [avatar] }))
    .route('/', storageRoutes())
  return { app, http }
}

type Http = ReturnType<typeof makeHttp>['http']
const json = (body: unknown, user = 'ann') => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-user': user } })

/** What useUpload() does in the browser, with `put` standing in for the browser's PUT. */
async function uploadThrough(http: Http, bytes: Uint8Array, declared: { type: string; size?: number; name?: string }, put: (url: string, init: RequestInit) => Response | Promise<Response>, user = 'ann') {
  const started = await http.request('http://localhost/_caldera/uploads', json({ upload: 'avatar', name: declared.name ?? 'me.png', size: declared.size ?? bytes.length, type: declared.type }, user))
  if (!started.ok) return { step: 'start', status: started.status, body: await started.json() }
  const { upload, token } = (await started.json()) as { upload: { url: string; headers: Record<string, string> }; token: string }
  const put_ = await put(upload.url, { method: 'PUT', body: bytes as never, headers: upload.headers })
  if (!put_.ok) return { step: 'put', status: put_.status, token }
  const done = await http.request('http://localhost/_caldera/uploads/complete', json({ token }, user))
  return { step: 'complete', status: done.status, body: await done.json(), token }
}

describe('direct uploads on a local disk (signed PUT served by storageRoutes)', () => {
  const setup = () => {
    const root = temp()
    const { app, http } = makeHttp({ driver: 'local', root, serve: { url: 'http://localhost', key: KEY } })
    const put = (url: string, init: RequestInit) => http.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'content-length': String((init.body as Uint8Array).length) } })
    return { app, http, put }
  }

  it('uploads, checks the real bytes, and moves the file into place', async () => {
    const { app, http, put } = setup()
    await app.boot({ env: {} })
    const result = await uploadThrough(http, png(64, 32), { type: 'image/png', name: 'Me at the beach.png' }, put)
    expect(result.status).toBe(200)
    const { file, detected } = result.body as { file: FileRef; detected: unknown }
    expect(fileRef.parse(file)).toMatchObject({ disk: 'files', mime: 'image/png', name: 'Me at the beach.png' })
    expect(file.key).toMatch(/^avatars\/[0-9a-f]{40}\.png$/)
    expect(detected).toEqual({ mime: 'image/png', ext: 'png', width: 64, height: 32 })
    expect(await app.services.storage.exists(file.key)).toBe(true)
    expect((await app.services.storage.list('tmp/uploads')).files).toEqual([])
    // A token works once.
    const again = await http.request('http://localhost/_caldera/uploads/complete', json({ token: result.token }))
    expect(again.status).toBe(400)
  })

  it('refuses before uploading: too large, not allowed, unknown kind', async () => {
    const { http } = setup()
    const tooBig = await http.request('http://localhost/_caldera/uploads', json({ upload: 'avatar', name: 'a.png', size: 5 * 1024 * 1024, type: 'image/png' }))
    expect(tooBig.status).toBe(422)
    expect((await http.request('http://localhost/_caldera/uploads', json({ upload: 'avatar', name: 'a.png', size: 10, type: 'image/png' }, 'banned'))).status).toBe(403)
    expect((await http.request('http://localhost/_caldera/uploads', json({ upload: 'nope', name: 'a.png', size: 10, type: 'image/png' }))).status).toBe(400)
  })

  it('deletes a file whose bytes break the rules, whatever was declared', async () => {
    const { app, http, put } = setup()
    await app.boot({ env: {} })
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const result = await uploadThrough(http, svg, { type: 'image/png', name: 'innocent.png' }, put)
    expect(result).toMatchObject({ step: 'complete', status: 422, body: { error: { fields: { file: ['SVG files can’t be uploaded.'] } } } })
    const tooWide = await uploadThrough(http, png(1000, 10), { type: 'image/png' }, put)
    expect(tooWide.body).toMatchObject({ error: { message: 'The image is 1000×10; the limit is 512×∞.' } })
    expect((await app.services.storage.list('')).files).toEqual([])
  })

  it('binds the token to the user, and refuses tampered ones', async () => {
    const { app, http, put } = setup()
    await app.boot({ env: {} })
    const started = await http.request('http://localhost/_caldera/uploads', json({ upload: 'avatar', name: 'a.png', size: png(4, 4).length, type: 'image/png' }))
    const { upload, token } = (await started.json()) as { upload: { url: string; headers: Record<string, string> }; token: string }
    await put(upload.url, { method: 'PUT', body: png(4, 4) as never, headers: upload.headers })
    expect((await http.request('http://localhost/_caldera/uploads/complete', json({ token }, 'mallory'))).status).toBe(403)
    const [payload, signature] = token.split('.')
    const forged = btoa(atob(payload!.replaceAll('-', '+').replaceAll('_', '/')).replace('"ann"', '"bob"')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    expect((await http.request('http://localhost/_caldera/uploads/complete', json({ token: `${forged}.${signature}` }, 'bob'))).status).toBe(403)
    expect((await http.request('http://localhost/_caldera/uploads/complete', json({ token }))).status).toBe(200)
  })

  it('signs the completed ref, and zupload() accepts only an untouched one of its kind', async () => {
    const { app, http, put } = setup()
    await app.boot({ env: {} })
    const result = await uploadThrough(http, png(8, 8), { type: 'image/png', name: 'me.png' }, put)
    const signed = (result.body as { file: SignedFileRef }).file
    expect(signed).toMatchObject({ upload: 'avatar', signature: expect.any(String), exp: expect.any(Number) })

    const schema = zupload(avatar)
    const parsed = await schema.safeParseAsync(signed)
    // What's stored is the plain ref, with nothing of the signature.
    expect(parsed.data).toEqual({ disk: 'files', key: signed.key, size: signed.size, mime: 'image/png', name: 'me.png' })
    expect((await schema.safeParseAsync(JSON.stringify(signed))).data).toEqual(parsed.data)

    // Someone else's file (a key seen in a URL), another disk, another kind, an old ref: all refused.
    const refused = async (value: unknown, s = schema) => expect((await s.safeParseAsync(value)).success).toBe(false)
    await refused({ ...signed, key: 'avatars/someone-elses.png' })
    await refused({ ...signed, disk: 'public' })
    await refused({ ...signed, size: 1 })
    await refused({ disk: 'files', key: signed.key, size: signed.size, mime: 'image/png', name: 'me.png' })
    await refused(signed, zupload('attachment'))
    await refused({ ...signed, signature: 'not base64!' })
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    try {
      await refused(signed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pruneUploads removes uploads never completed', async () => {
    const { app } = setup()
    await app.boot({ env: {} })
    await app.services.storage.put('tmp/uploads/abandoned', 'x')
    await app.services.storage.put('avatars/kept.png', 'x')
    expect(await pruneUploads(app.services.storage, { olderThan: 0 })).toBe(1)
    expect((await app.services.storage.list('')).files.map((f) => f.key)).toEqual(['avatars/kept.png'])
  })
})

describe.runIf(hasDocker)('direct uploads to real S3 (SeaweedFS)', () => {
  let server: Awaited<ReturnType<typeof startS3>>
  beforeAll(async () => {
    server = await startS3('uploads')
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  })

  it('the browser PUTs straight to the bucket; completion checks and moves it', async () => {
    const { app, http } = makeHttp({ driver: 's3', bucket: 'uploads', endpoint: server.endpoint, ...S3_CREDENTIALS }, [s3StorageDriver as never])
    await app.boot({ env: {} })
    const result = await uploadThrough(http, png(40, 40), { type: 'image/png' }, (url, init) => fetch(url, init))
    expect(result.status).toBe(200)
    const file = (result.body as { file: FileRef }).file
    expect(await app.services.storage.exists(file.key)).toBe(true)
    // Declaring a smaller size than the real file: the bucket refuses the PUT itself.
    const lying = await uploadThrough(http, png(40, 40), { type: 'image/png', size: 10 }, (url, init) => fetch(url, init))
    expect(lying.step).toBe('put')
  })
})

describe('cleanupFiles on a model', () => {
  it('deletes replaced and force-deleted files after commit, keeps them on soft delete and rollback', async () => {
    const storage = createStorage({ default: 'files', disks: { files: { driver: 'memory' } } })
    setDefaultStorage(storage)
    const client = createClient({ url: `file:${join(temp(), 'app.db')}` })
    const posts = snakeCase.table('posts', { id: integer().primaryKey({ autoIncrement: true }), title: text().notNull(), cover: zjson(fileRef), deletedAt: integer({ mode: 'timestamp_ms' }) })
    const relations = defineRelations({ posts })
    const db = createDatabase(drizzle({ client, relations }), { driver: 'sqlite' })
    await db.client.run(sql.raw('create table posts (id integer primary key autoincrement, title text not null, cover text, deleted_at integer)'))
    setDefaultDatabase(() => db)
    const Post = defineModel(posts as never, { name: 'post', softDeletes: 'deletedAt', hooks: { ...cleanupFiles('cover') } } as never) as any
    const ref = async (key: string): Promise<FileRef> => {
      await storage.put(key, 'img')
      return { disk: 'files', key, size: 3, mime: 'image/png', name: key }
    }
    try {
      const post = await Post.create({ title: 'a', cover: await ref('covers/1.png') })
      await Post.update(post, { cover: await ref('covers/2.png') })
      expect(await storage.exists('covers/1.png')).toBe(false)
      await db
        .transaction(async () => {
          await Post.update(post, { cover: await ref('covers/3.png') })
          throw new Error('rollback')
        })
        .catch(() => {})
      expect(await storage.exists('covers/2.png')).toBe(true)
      await Post.delete(post)
      expect(await storage.exists('covers/2.png')).toBe(true) // soft delete: a restore still has its cover
      // `post` is the stale row from create (cover 1): the model re-reads it, so cover 2 is the one deleted.
      await Post.forceDelete(post)
      expect(await storage.exists('covers/2.png')).toBe(false)
    } finally {
      setDefaultDatabase(undefined)
      setDefaultStorage(undefined)
      client.close()
    }
  })
})

describe('fileResponse', () => {
  it('serves a stored ref from its own disk, as a download named like the original', async () => {
    const storage = createStorage({ default: 'files', disks: { files: { driver: 'memory' }, other: { driver: 'memory' } } })
    await storage.disk('other').put('docs/a1.pdf', '%PDF-1.4', { contentType: 'application/pdf' })
    const ref: FileRef = { disk: 'other', key: 'docs/a1.pdf', size: 8, mime: 'application/pdf', name: 'Q3 report.pdf' }
    const res = await fileResponse(ref, {}, storage)
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Q3%20report.pdf")
    expect(res.headers.get('cache-control')).toBe('private, max-age=0')
    expect(await res.text()).toBe('%PDF-1.4')
    expect((await fileResponse(ref, { inline: true }, storage)).headers.get('content-disposition')).toBeNull()
  })
})

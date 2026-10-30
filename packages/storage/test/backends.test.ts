import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStorage, type StorageService } from '../src/index.js'
import { s3StorageDriver } from '../src/s3.js'
import { png } from './files.js'
import { hasDocker, S3_CREDENTIALS, startS3 } from './s3-server.js'

describe.runIf(hasDocker)('s3 driver (SeaweedFS S3 in Docker, real SigV4)', () => {
  let server: Awaited<ReturnType<typeof startS3>>
  let storage: StorageService
  beforeAll(async () => {
    server = await startS3('caldera-test')
    storage = createStorage(
      { default: 's3', disks: { s3: { driver: 's3', bucket: 'caldera-test', endpoint: server.endpoint, region: 'us-east-1', ...S3_CREDENTIALS } } },
      { drivers: [s3StorageDriver] },
    )
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  })

  it('puts, reads (and ranges), copies, lists across pages and deletes', async () => {
    await storage.put('docs/a.txt', 'hello world', { contentType: 'text/plain' })
    expect(await storage.getText('docs/a.txt')).toBe('hello world')
    expect(await storage.info('docs/a.txt')).toMatchObject({ key: 'docs/a.txt', size: 11, contentType: 'text/plain' })
    expect(new TextDecoder().decode(await new Response(await storage.getStream('docs/a.txt', { start: 6, end: 10 })).arrayBuffer())).toBe('world')
    await storage.copy('docs/a.txt', 'docs/b c.txt')
    for (let i = 0; i < 3; i++) await storage.put(`docs/n${i}.txt`, String(i))
    const first = await storage.list('docs', { limit: 2 })
    const rest = await storage.list('docs', { limit: 10, cursor: first.cursor! })
    expect([...first.files, ...rest.files].map((f) => f.key)).toEqual(['docs/a.txt', 'docs/b c.txt', 'docs/n0.txt', 'docs/n1.txt', 'docs/n2.txt'])
    await storage.delete('docs/a.txt')
    expect(await storage.exists('docs/a.txt')).toBe(false)
    await expect(storage.get('docs/a.txt')).rejects.toMatchObject({ code: 'file_not_found' })
  })

  it('makes presigned download URLs that work, and stop working once tampered with', async () => {
    await storage.put('private/report.pdf', 'pdf!', { contentType: 'application/pdf' })
    const url = await storage.temporaryUrl('private/report.pdf', '5m', { downloadAs: 'Report.pdf' })
    const ok = await fetch(url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('pdf!')
    expect((await fetch(url.replace('report.pdf', 'other.pdf'))).status).toBe(403)
    expect((await fetch(`${server.endpoint}/caldera-test/private/report.pdf`)).status).toBe(403) // no signature
  })

  it('makes presigned uploads that only accept the signed type and size', async () => {
    const body = png(8, 8)
    const upload = await storage.temporaryUploadUrl('tmp/up.png', { expiresIn: '5m', contentType: 'image/png', contentLength: body.length })
    const wrongType = await fetch(upload.url, { method: 'PUT', body: body as BlobPart as never, headers: { ...upload.headers, 'content-type': 'text/html' } })
    expect(wrongType.ok).toBe(false)
    // A bigger file than declared: its Content-Length no longer matches the signature.
    const wrongSize = await fetch(upload.url, { method: 'PUT', body: png(16, 16) as never, headers: upload.headers })
    expect(wrongSize.ok).toBe(false)
    const ok = await fetch(upload.url, { method: 'PUT', body: body as never, headers: upload.headers })
    expect(ok.status).toBe(200)
    expect(await storage.get('tmp/up.png')).toEqual(body)
  })
})

describe('r2 driver (Miniflare, real workerd R2)', () => {
  let mf: Miniflare
  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `
          import { createStorage } from '@caldera/storage'
          export default {
            async fetch(request, env) {
              const storage = createStorage({ default: 'r2', disks: { r2: { driver: 'r2', bucket: env.BUCKET, publicUrl: 'https://files.example.test' } } })
              await storage.put('a/hello.txt', 'hi from r2', { contentType: 'text/plain' })
              await storage.put('a/two.txt', 'two')
              const listed = (await storage.list('a')).files.map((f) => f.key)
              const range = new TextDecoder().decode(await new Response(await storage.getStream('a/hello.txt', { start: 3, end: 6 })).arrayBuffer())
              await storage.move('a/two.txt', 'b/two.txt')
              return Response.json({
                text: await storage.getText('a/hello.txt'), info: await storage.info('a/hello.txt'), listed, range,
                moved: [await storage.exists('a/two.txt'), await storage.exists('b/two.txt')],
                url: storage.url('a/hello.txt'), caps: storage.capabilities,
                temporary: await storage.temporaryUrl('a/hello.txt', 60).catch((e) => e.message),
              })
            },
          }`,
        resolveDir: join(import.meta.dirname, '..'),
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      write: false,
      logLevel: 'silent',
      alias: { '@caldera/storage': join(import.meta.dirname, '../src/index.ts') },
    })
    mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], r2Buckets: ['BUCKET'] })
    await mf.ready
  }, 60_000)
  afterAll(async () => {
    await mf?.dispose()
  })

  it('works through the binding, with no Node APIs in the bundle', async () => {
    const body = (await (await mf.dispatchFetch('http://localhost/')).json()) as Record<string, any>
    expect(body).toMatchObject({
      text: 'hi from r2',
      info: { key: 'a/hello.txt', size: 10, contentType: 'text/plain' },
      listed: ['a/hello.txt', 'a/two.txt'],
      range: 'from',
      moved: [false, true],
      url: 'https://files.example.test/a/hello.txt',
      caps: { publicUrls: true, signedUrls: false, visibility: false },
      temporary: `The "r2" disk can't make temporary URLs (no signedUrls).`,
    })
  })
})

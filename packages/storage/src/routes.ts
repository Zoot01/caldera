import { Hono, type Context } from 'hono'
import { contentDisposition, type Disk } from './disk.js'
import { normalizeKey } from './key.js'
import { SIGNED_ROUTE_PREFIX } from './signing.js'

interface StorageLike {
  disk(name: string): Disk
}

/**
 * Serves and receives the signed URLs of disks that Caldera signs itself (local disks with `serve`),
 * Laravel's ServeFile/ReceiveFile. Downloads are streamed; an upload must match the signed type and
 * size exactly. Expired, tampered or foreign URLs get 403 and reveal nothing about the file.
 */
export function storageRoutes(): Hono {
  const forbidden = (c: Context) => c.json({ error: { code: 'forbidden', message: 'This link is invalid or has expired.', status: 403 } }, 403)

  const resolve = (c: Context) => {
    const storage = (c.var as { storage?: StorageLike }).storage
    if (!storage) throw new Error('storageRoutes() needs storageProvider() in the app.')
    const prefix = `${SIGNED_ROUTE_PREFIX}/${encodeURIComponent(c.req.param('disk') ?? '')}/`
    const path = new URL(c.req.url).pathname
    try {
      const key = normalizeKey(decodeURIComponent(path.slice(path.indexOf(prefix) + prefix.length)))
      return { disk: storage.disk(c.req.param('disk')!), key }
    } catch {
      return undefined
    }
  }

  return new Hono()
    .get(`${SIGNED_ROUTE_PREFIX}/:disk/*`, async (c) => {
      const target = resolve(c)
      const verify = target?.disk.driver.verifySignature
      const downloadAs = c.req.query('download')
      const fields = { method: 'GET' as const, disk: target?.disk.name ?? '', key: target?.key ?? '', expires: Number(c.req.query('expires')), ...(downloadAs ? { downloadAs } : {}) }
      if (!target || !verify || !(await verify(fields, c.req.query('signature') ?? ''))) return forbidden(c)
      const response = await target.disk.response(target.key, { cacheControl: 'private, max-age=0', ...(downloadAs ? { downloadAs } : {}) })
      if (downloadAs) response.headers.set('content-disposition', contentDisposition(downloadAs))
      return response
    })
    .put(`${SIGNED_ROUTE_PREFIX}/:disk/*`, async (c) => {
      const target = resolve(c)
      const verify = target?.disk.driver.verifySignature
      const contentType = c.req.header('content-type') ?? ''
      const contentLength = Number(c.req.header('content-length'))
      const fields = { method: 'PUT' as const, disk: target?.disk.name ?? '', key: target?.key ?? '', expires: Number(c.req.query('expires')), contentType, contentLength }
      if (!target || !verify || !Number.isFinite(contentLength) || !(await verify(fields, c.req.query('signature') ?? ''))) return forbidden(c)
      // The signed size is a promise the body must keep: read one byte past it to catch a longer one.
      const bytes = await readAtMost(c.req.raw.body, contentLength + 1)
      if (bytes.length !== contentLength) return c.json({ error: { code: 'size_mismatch', message: 'The upload is not the signed size.', status: 400 } }, 400)
      await target.disk.put(target.key, bytes, { contentType })
      return c.body(null, 200, { etag: (await target.disk.info(target.key)).etag ?? '' })
    })
}

async function readAtMost(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(size, max))
  let offset = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - offset)
    out.set(part, offset)
    offset += part.length
    if (offset >= out.length) break
  }
  return out
}

import { CalderaError, defineDriver } from '@caldera-js/core'
import { AwsClient } from 'aws4fetch'
import { z } from 'zod'
import { contentDisposition } from './disk.js'
import type { FileInfo, StorageCapabilities, StorageDriver } from './driver.js'

const configSchema = z.object({
  bucket: z.string().min(1),
  /** `auto` for R2. */
  region: z.string().default('us-east-1'),
  /** For S3-compatible services: R2 (`https://<account>.r2.cloudflarestorage.com`), MinIO, Tigris… Default: AWS. */
  endpoint: z.url().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  /** `endpoint/bucket/key` instead of `bucket.endpoint/key`. Default: true with a custom endpoint. */
  forcePathStyle: z.boolean().optional(),
  /** Base URL files are publicly readable at (a CDN or the bucket's public domain), if any. */
  publicUrl: z.string().optional(),
  /** Per-object ACLs (`x-amz-acl`). Default: true, except on R2, which has none. */
  acl: z.boolean().optional(),
})
type S3Config = z.infer<typeof configSchema>

const isR2 = (config: S3Config) => Boolean(config.endpoint?.includes('r2.cloudflarestorage.com'))

/**
 * Amazon S3 and S3-compatible storage (R2, MinIO, Tigris, Backblaze B2…), signed with aws4fetch: small,
 * fetch-based, and runs on every runtime including Workers. Temporary and upload URLs are real
 * presigned URLs; uploads have their content type and size signed in.
 */
export function s3Storage(config: S3Config): StorageDriver {
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: 's3' })
  const endpoint = (config.endpoint ?? `https://s3.${config.region}.amazonaws.com`).replace(/\/$/, '')
  const pathStyle = config.forcePathStyle ?? Boolean(config.endpoint)
  const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')
  const bucketUrl = pathStyle ? `${endpoint}/${config.bucket}` : endpoint.replace('://', `://${config.bucket}.`)
  const objectUrl = (key: string) => `${bucketUrl}/${encodeKey(key)}`
  const acl = config.acl ?? !isR2(config)

  const send = async (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await client.fetch(url, init)
    return response
  }
  const fail = async (response: Response, what: string): Promise<never> => {
    const text = await response.text().catch(() => '')
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(response.status)
    throw new CalderaError('storage_request_failed', `S3 ${what} failed: ${code} (HTTP ${response.status}).`, { status: response.status, code })
  }
  const infoFrom = (key: string, headers: Headers): FileInfo => ({
    key,
    size: Number(headers.get('content-range')?.split('/')[1] ?? headers.get('content-length') ?? 0),
    contentType: headers.get('content-type') ?? undefined,
    etag: headers.get('etag') ?? undefined,
    lastModified: headers.get('last-modified') ? new Date(headers.get('last-modified')!) : undefined,
  })

  return {
    async put(key, body, options) {
      // S3 needs a known length (no chunked PUTs), so streams are buffered first.
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
      // fetch sets Content-Length from the body (setting it by hand is refused).
      const headers: Record<string, string> = {}
      if (options.contentType) headers['content-type'] = options.contentType
      if (options.cacheControl) headers['cache-control'] = options.cacheControl
      if (options.contentDisposition) headers['content-disposition'] = options.contentDisposition
      if (options.visibility && acl) headers['x-amz-acl'] = options.visibility === 'public' ? 'public-read' : 'private'
      const response = await send(objectUrl(key), { method: 'PUT', headers, body: bytes as Uint8Array<ArrayBuffer> })
      if (!response.ok) await fail(response, `PUT ${key}`)
    },
    async get(key, range) {
      const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end ?? ''}` } : {}
      const response = await send(objectUrl(key), { headers })
      if (response.status === 404) return null
      if (!response.ok) await fail(response, `GET ${key}`)
      return { body: response.body as ReadableStream<Uint8Array>, info: infoFrom(key, response.headers) }
    },
    async head(key) {
      const response = await send(objectUrl(key), { method: 'HEAD' })
      if (response.status === 404) return null
      if (!response.ok) await fail(response, `HEAD ${key}`)
      return infoFrom(key, response.headers)
    },
    async delete(key) {
      const response = await send(objectUrl(key), { method: 'DELETE' })
      if (!response.ok && response.status !== 404) await fail(response, `DELETE ${key}`)
    },
    async copy(from, to) {
      const response = await send(objectUrl(to), { method: 'PUT', headers: { 'x-amz-copy-source': `/${config.bucket}/${encodeKey(from)}` } })
      // CopyObject can answer 200 with an error in the body.
      const text = response.ok ? await response.text() : ''
      if (!response.ok || text.includes('<Error>')) await fail(response.ok ? new Response(text, { status: 500 }) : response, `copy ${from} → ${to}`)
    },
    async list(prefix, { cursor, limit }) {
      const url = new URL(bucketUrl)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('max-keys', String(limit))
      if (prefix) url.searchParams.set('prefix', prefix)
      if (cursor) url.searchParams.set('continuation-token', cursor)
      const response = await send(url.toString())
      if (!response.ok) await fail(response, `list ${prefix || '/'}`)
      const xml = await response.text()
      const files = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, item]) => {
        const field = (name: string) => unescapeXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item!)?.[1] ?? '')
        return { key: field('Key'), size: Number(field('Size')), contentType: undefined, etag: field('ETag') || undefined, lastModified: field('LastModified') ? new Date(field('LastModified')) : undefined }
      })
      const next = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : undefined
      return { files, cursor: next || undefined }
    },
    ...(config.publicUrl ? { url: (key: string) => `${config.publicUrl!.replace(/\/$/, '')}/${encodeKey(key)}` } : {}),
    async signedUrl(key, options) {
      const url = new URL(objectUrl(key))
      url.searchParams.set('X-Amz-Expires', String(Math.ceil(options.expiresIn)))
      if (options.downloadAs) url.searchParams.set('response-content-disposition', contentDisposition(options.downloadAs))
      return (await client.sign(url.toString(), { method: 'GET', aws: { signQuery: true } })).url
    },
    async signedUpload(key, options) {
      const url = new URL(objectUrl(key))
      url.searchParams.set('X-Amz-Expires', String(Math.ceil(options.expiresIn)))
      // allHeaders: the type and length are signed in, so only the declared file can be uploaded. The
      // client sends Content-Type; Content-Length comes from the body (browsers won't let code set it).
      const signed = await client.sign(url.toString(), { method: 'PUT', headers: { 'content-type': options.contentType, 'content-length': String(options.contentLength) }, aws: { signQuery: true, allHeaders: true } })
      return { url: signed.url, method: 'PUT' as const, headers: { 'content-type': options.contentType }, expiresAt: new Date(Date.now() + options.expiresIn * 1000).toISOString() }
    },
  }
}

function unescapeXml(text: string): string {
  return text.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

export const s3StorageDriver = defineDriver<StorageDriver, StorageCapabilities, S3Config>({
  name: 's3',
  schema: configSchema,
  capabilities: (config) => ({ publicUrls: Boolean(config.publicUrl), signedUrls: true, presignedUploads: true, visibility: config.acl ?? !isR2(config), rangeReads: true }),
  create: (config) => s3Storage(config),
})

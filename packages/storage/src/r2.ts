import { CalderaError, defineDriver } from '@caldera-js/core'
import { z } from 'zod'
import type { FileInfo, StorageCapabilities, StorageDriver } from './driver.js'

/** The parts of a Workers R2 binding (`env.BUCKET`) the driver uses. */
export interface R2BucketLike {
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string } }): Promise<unknown>
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectLike & { body: ReadableStream } | null>
  head(key: string): Promise<R2ObjectLike | null>
  delete(keys: string | string[]): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>
}
interface R2ObjectLike {
  key: string
  size: number
  httpEtag?: string
  uploaded?: Date
  httpMetadata?: { contentType?: string }
}

const info = (o: R2ObjectLike): FileInfo => ({ key: o.key, size: o.size, contentType: o.httpMetadata?.contentType, etag: o.httpEtag, lastModified: o.uploaded })

/**
 * Cloudflare R2 through the Workers binding: fast, no credentials. The binding can't sign URLs; for
 * temporary or upload URLs use the `s3` driver with R2's S3 endpoint (from @caldera-js/storage/s3).
 * Public URLs come from the bucket's public domain, if it has one.
 */
export function r2Storage(bucket: R2BucketLike, options: { publicUrl?: string } = {}): StorageDriver {
  return {
    async put(key, body, opts) {
      await bucket.put(key, body, {
        httpMetadata: {
          ...(opts.contentType ? { contentType: opts.contentType } : {}),
          ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
          ...(opts.contentDisposition ? { contentDisposition: opts.contentDisposition } : {}),
        },
      })
    },
    async get(key, range) {
      const object = await bucket.get(key, range ? { range: { offset: range.start, ...(range.end !== undefined ? { length: range.end - range.start + 1 } : {}) } } : undefined)
      return object ? { body: object.body as ReadableStream<Uint8Array>, info: info(object) } : null
    },
    async head(key) {
      const object = await bucket.head(key)
      return object ? info(object) : null
    },
    async delete(key) {
      await bucket.delete(key)
    },
    async list(prefix, { cursor, limit }) {
      const page = await bucket.list({ prefix, limit, ...(cursor ? { cursor } : {}) })
      return { files: page.objects.map(info), cursor: page.truncated ? page.cursor : undefined }
    },
    ...(options.publicUrl ? { url: (key: string) => `${options.publicUrl!.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}` } : {}),
  }
}

const isBucket = (value: unknown): value is R2BucketLike => typeof (value as R2BucketLike | undefined)?.head === 'function' && typeof (value as R2BucketLike).list === 'function'

export const r2StorageDriver = defineDriver<StorageDriver, StorageCapabilities, { bucket: R2BucketLike; publicUrl?: string }>({
  name: 'r2',
  schema: z.object({ bucket: z.custom<R2BucketLike>(isBucket, 'must be an R2 bucket binding (env.MY_BUCKET)'), publicUrl: z.url().optional() }),
  capabilities: (config) => ({ publicUrls: Boolean(config.publicUrl), signedUrls: false, presignedUploads: false, visibility: false, rangeReads: true }),
  create: (config) => {
    if (!config.bucket) throw new CalderaError('storage_config', 'The r2 disk needs `bucket`.')
    return r2Storage(config.bucket, config.publicUrl ? { publicUrl: config.publicUrl } : {})
  },
})

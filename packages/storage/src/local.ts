import { mkdir, open, readdir, rename, rm, stat, copyFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { CalderaError, defineDriver } from '@caldera/core'
import { z } from 'zod'
import type { FileInfo, StorageCapabilities, StorageDriver } from './driver.js'
import { createUrlSigner, signedRouteUrl } from './signing.js'

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'text/javascript',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', zip: 'application/zip', xml: 'application/xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const typeOf = (key: string) => TYPES[key.split('.').pop()?.toLowerCase() ?? '']

const configSchema = z.object({
  /** Folder the disk lives in, relative to the working directory. */
  root: z.string().min(1),
  /** Base URL its files are publicly served at (e.g. `/storage` served from public/storage), if any. */
  publicUrl: z.string().optional(),
  /**
   * Sign temporary and upload URLs, served by `storageRoutes()`, with `key` (APP_KEY). Links are
   * relative unless `url` is set: set it (the app's public URL) only for links used outside a page, like in emails.
   */
  serve: z.object({ url: z.url().optional(), key: z.string().min(32, 'must be at least 32 characters (use APP_KEY)') }).optional(),
})
type LocalConfig = z.infer<typeof configSchema>

/**
 * Files in a folder on this machine (Node and Bun). Writes are atomic (a temp file, then a rename),
 * and keys can never resolve outside `root`. With `serve`, temporary and upload URLs work like a
 * bucket's, so a presigned upload flow can be developed locally.
 */
export function localStorage(config: LocalConfig, diskName: string): StorageDriver {
  const root = resolve(config.root)
  const pathOf = (key: string) => {
    const path = resolve(root, key)
    if (path !== root && !path.startsWith(root + sep)) throw new CalderaError('storage_key_invalid', `"${key}" resolves outside the disk.`, { key })
    return path
  }
  const infoOf = async (key: string): Promise<FileInfo | null> => {
    try {
      const s = await stat(pathOf(key))
      if (!s.isFile()) return null
      return { key, size: s.size, contentType: typeOf(key), etag: `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`, lastModified: s.mtime }
    } catch {
      return null
    }
  }
  const signer = config.serve ? createUrlSigner(config.serve.key) : undefined

  return {
    async put(key, body) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${crypto.randomUUID()}.tmp`
      const handle = await open(temp, 'w')
      try {
        if (body instanceof Uint8Array) await handle.write(body)
        else for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) await handle.write(chunk)
      } finally {
        await handle.close()
      }
      await rename(temp, path)
    },
    async get(key, range) {
      const info = await infoOf(key)
      if (!info) return null
      const node = createReadStream(pathOf(key), range ? { start: range.start, ...(range.end !== undefined ? { end: range.end } : {}) } : {})
      return { body: Readable.toWeb(node) as ReadableStream<Uint8Array>, info }
    },
    head: infoOf,
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
    async copy(from, to) {
      await mkdir(dirname(pathOf(to)), { recursive: true })
      await copyFile(pathOf(from), pathOf(to))
    },
    async list(prefix, { cursor, limit }) {
      const keys: string[] = []
      const walk = async (dir: string) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else if (!entry.name.endsWith('.tmp')) keys.push(relative(root, full).split(sep).join('/'))
        }
      }
      await walk(root)
      const matching = keys.filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort()
      const page = matching.slice(0, limit)
      return { files: (await Promise.all(page.map(infoOf))).filter((f): f is FileInfo => f !== null), cursor: matching.length > limit ? page.at(-1) : undefined }
    },
    ...(config.publicUrl ? { url: (key: string) => `${config.publicUrl!.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}` } : {}),
    ...(signer && config.serve
      ? {
          signedUrl: (key: string, options: { expiresIn: number; downloadAs?: string }) =>
            signedRouteUrl(signer, config.serve?.url, { method: 'GET', disk: diskName, key, expires: Math.floor(Date.now() / 1000 + options.expiresIn), ...(options.downloadAs ? { downloadAs: options.downloadAs } : {}) }),
          signedUpload: async (key: string, options: { expiresIn: number; contentType: string; contentLength: number }) => {
            const expires = Math.floor(Date.now() / 1000 + options.expiresIn)
            const url = await signedRouteUrl(signer, config.serve?.url, { method: 'PUT', disk: diskName, key, expires, contentType: options.contentType, contentLength: options.contentLength })
            // Content-Length comes from the body (browsers won't let code set it); it's still signed in.
            return { url, method: 'PUT' as const, headers: { 'content-type': options.contentType }, expiresAt: new Date(expires * 1000).toISOString() }
          },
          verifySignature: (fields: Parameters<typeof signer.verify>[0], signature: string) => signer.verify(fields, signature),
        }
      : {}),
  }
}

export const localStorageDriver = defineDriver<StorageDriver, StorageCapabilities, LocalConfig>({
  name: 'local',
  schema: configSchema,
  capabilities: (config) => ({ publicUrls: Boolean(config.publicUrl), signedUrls: Boolean(config.serve), presignedUploads: Boolean(config.serve), visibility: false, rangeReads: true }),
  create: (config, context) => localStorage(config, context.name),
})

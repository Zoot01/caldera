import { CalderaError, parseDuration, type Duration } from '@caldera/core'
import type { FileInfo, PutOptions, SignedUpload, StorageCapabilities, StorageDriver } from './driver.js'
import { normalizeKey, normalizePrefix } from './key.js'
import { sniff } from './sniff.js'

export type Body = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>

export class FileNotFoundError extends CalderaError {
  constructor(disk: string, key: string) {
    super('file_not_found', `No file "${key}" on the "${disk}" disk.`, { disk, key })
  }
}

export interface Disk {
  readonly name: string
  readonly capabilities: StorageCapabilities
  /** The backend, for anything the disk API doesn't cover. */
  readonly driver: StorageDriver
  /** Stores a file. A string is stored as UTF-8. */
  put(key: string, body: Body, options?: PutOptions): Promise<FileInfo>
  /**
   * Stores an uploaded file under `directory` with a random name and the extension of what the bytes
   * really are (never the client's file name or type). Returns its key.
   */
  putFile(directory: string, file: Blob, options?: Omit<PutOptions, 'contentType'>): Promise<string>
  /** The whole file. Throws `FileNotFoundError`. */
  get(key: string): Promise<Uint8Array>
  getText(key: string): Promise<string>
  getStream(key: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>>
  exists(key: string): Promise<boolean>
  /** Size, type and dates. Throws `FileNotFoundError`. */
  info(key: string): Promise<FileInfo>
  delete(...keys: string[]): Promise<void>
  copy(from: string, to: string): Promise<void>
  move(from: string, to: string): Promise<void>
  /** Every file under `prefix` (recursively), page by page. */
  list(prefix?: string, options?: { limit?: number; cursor?: string }): Promise<{ files: FileInfo[]; cursor: string | undefined }>
  /** All files under `prefix`, following every page. */
  listAll(prefix?: string): AsyncIterable<FileInfo>
  /** The permanent public URL. Needs `publicUrls`. */
  url(key: string): string
  /** An expiring download URL. Needs `signedUrls`. */
  temporaryUrl(key: string, expiresIn: Duration, options?: { downloadAs?: string }): Promise<string>
  /** An expiring URL a browser PUTs the file to, with its type and size signed in. Needs `presignedUploads`. */
  temporaryUploadUrl(key: string, options: { expiresIn: Duration; contentType: string; contentLength: number }): Promise<SignedUpload>
  /** A streaming `Response` for the file (404 when missing), for routes that serve files. */
  response(key: string, options?: { downloadAs?: string; cacheControl?: string }): Promise<Response>
}

export function createDisk(name: string, driver: StorageDriver, capabilities: StorageCapabilities): Disk {
  const need = (capability: keyof StorageCapabilities, method: string) => {
    if (!capabilities[capability]) {
      throw new CalderaError('capability_missing', `The "${name}" disk can't ${method} (no ${capability}).`, { disk: name, capability })
    }
  }

  const put: Disk['put'] = async (rawKey, body, options = {}) => {
    const key = normalizeKey(rawKey)
    if (options.visibility && !capabilities.visibility) need('visibility', 'set per-file visibility')
    const { bytes, stream, type } = await toBody(body)
    const contentType = options.contentType ?? type
    await driver.put(key, bytes ?? stream!, { ...options, ...(contentType ? { contentType } : {}), ...(bytes ? { size: bytes.length } : {}) })
    return (await driver.head(key)) ?? { key, size: bytes?.length ?? 0, contentType, etag: undefined, lastModified: undefined }
  }

  const disk: Disk = {
    name,
    capabilities,
    driver,
    put,
    async putFile(directory, file, options = {}) {
      const head = new Uint8Array(await file.slice(0, 4100).arrayBuffer())
      const detected = await sniff(head)
      const key = `${normalizePrefix(directory)}${randomName()}${detected ? `.${detected.ext}` : ''}`
      await put(key, file, { ...options, contentType: detected?.mime ?? 'application/octet-stream' })
      return key
    },
    async get(key) {
      return new Uint8Array(await new Response(await disk.getStream(key)).arrayBuffer())
    },
    async getText(key) {
      return new TextDecoder().decode(await disk.get(key))
    },
    async getStream(rawKey, range) {
      const key = normalizeKey(rawKey)
      if (range) need('rangeReads', 'read byte ranges')
      const found = await driver.get(key, range)
      if (!found) throw new FileNotFoundError(name, key)
      return found.body
    },
    async exists(key) {
      return (await driver.head(normalizeKey(key))) !== null
    },
    async info(rawKey) {
      const key = normalizeKey(rawKey)
      const found = await driver.head(key)
      if (!found) throw new FileNotFoundError(name, key)
      return found
    },
    async delete(...keys) {
      for (const key of keys) await driver.delete(normalizeKey(key))
    },
    async copy(rawFrom, rawTo) {
      const from = normalizeKey(rawFrom)
      const to = normalizeKey(rawTo)
      if (driver.copy) {
        if (!(await driver.head(from))) throw new FileNotFoundError(name, from)
        return driver.copy(from, to)
      }
      const found = await driver.get(from)
      if (!found) throw new FileNotFoundError(name, from)
      await driver.put(to, found.body, { ...(found.info.contentType ? { contentType: found.info.contentType } : {}), size: found.info.size })
    },
    async move(from, to) {
      await disk.copy(from, to)
      await driver.delete(normalizeKey(from))
    },
    list(prefix, options = {}) {
      return driver.list(normalizePrefix(prefix), { limit: options.limit ?? 1000, ...(options.cursor ? { cursor: options.cursor } : {}) })
    },
    async *listAll(prefix) {
      let cursor: string | undefined
      do {
        const page = await disk.list(prefix, { ...(cursor ? { cursor } : {}) })
        yield* page.files
        cursor = page.cursor
      } while (cursor)
    },
    url(key) {
      need('publicUrls', 'make public URLs')
      return driver.url!(normalizeKey(key))
    },
    async temporaryUrl(key, expiresIn, options = {}) {
      need('signedUrls', 'make temporary URLs')
      return driver.signedUrl!(normalizeKey(key), { expiresIn: parseDuration(expiresIn), ...(options.downloadAs ? { downloadAs: options.downloadAs } : {}) })
    },
    async temporaryUploadUrl(key, options) {
      need('presignedUploads', 'make upload URLs')
      return driver.signedUpload!(normalizeKey(key), { expiresIn: parseDuration(options.expiresIn), contentType: options.contentType, contentLength: options.contentLength })
    },
    async response(rawKey, options = {}) {
      const key = normalizeKey(rawKey)
      const found = await driver.get(key)
      if (!found) return new Response('Not found.', { status: 404 })
      const headers = new Headers({
        'content-type': found.info.contentType ?? 'application/octet-stream',
        'content-length': String(found.info.size),
        // Served files are never sniffed into HTML by the browser.
        'x-content-type-options': 'nosniff',
      })
      if (options.cacheControl) headers.set('cache-control', options.cacheControl)
      if (found.info.etag) headers.set('etag', found.info.etag)
      if (options.downloadAs) headers.set('content-disposition', contentDisposition(options.downloadAs))
      return new Response(found.body, { headers })
    },
  }
  return disk
}

/** RFC 6266: an ASCII fallback plus the UTF-8 name, so any file name downloads correctly. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function randomName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function toBody(body: Body): Promise<{ bytes?: Uint8Array; stream?: ReadableStream<Uint8Array>; type?: string }> {
  if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), type: 'text/plain; charset=utf-8' }
  if (body instanceof Uint8Array) return { bytes: body }
  if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body) }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return { bytes: new Uint8Array(await body.arrayBuffer()), ...(body.type ? { type: body.type } : {}) }
  return { stream: body as ReadableStream<Uint8Array> }
}

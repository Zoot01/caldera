import { defineDriver } from '@caldera-js/core'
import type { FileInfo, StorageCapabilities, StorageDriver } from './driver.js'

interface Stored {
  bytes: Uint8Array
  info: FileInfo
}

/** Files in this process's memory. Tests (`storage.fake()`) and development. */
export function memoryStorage(): StorageDriver & { readonly files: ReadonlyMap<string, Stored> } {
  const files = new Map<string, Stored>()
  const stream = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
  return {
    files,
    async put(key, body, options) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>))
      files.set(key, {
        bytes: bytes.slice(),
        info: { key, size: bytes.length, contentType: options.contentType, etag: `"${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}"`, lastModified: new Date() },
      })
    },
    async get(key, range) {
      const file = files.get(key)
      if (!file) return null
      const bytes = range ? file.bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : file.bytes
      return { body: stream(bytes), info: file.info }
    },
    async head(key) {
      return files.get(key)?.info ?? null
    },
    async delete(key) {
      files.delete(key)
    },
    async list(prefix, { cursor, limit }) {
      const keys = [...files.keys()].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort()
      const page = keys.slice(0, limit)
      return { files: page.map((k) => files.get(k)!.info), cursor: keys.length > limit ? page.at(-1) : undefined }
    },
  }
}

export const memoryStorageDriver = defineDriver<StorageDriver, StorageCapabilities>({
  name: 'memory',
  capabilities: { publicUrls: false, signedUrls: false, presignedUploads: false, visibility: false, rangeReads: true },
  create: () => memoryStorage(),
})

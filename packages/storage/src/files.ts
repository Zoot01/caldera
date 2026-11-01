import { CalderaError, type Duration } from '@caldera-js/core'
import type { Disk } from './disk.js'
import type { FileRef } from './uploads.js'

interface StorageLike {
  disk(name: string): Disk
}

const DEFAULT = Symbol.for('caldera.storage.default')
const registry = globalThis as { [DEFAULT]?: StorageLike }

/** The app's storage (set by `storageProvider`), for model hooks and helpers outside a request. */
export function setDefaultStorage(storage: StorageLike | undefined) {
  registry[DEFAULT] = storage
}

export function defaultStorage(): StorageLike {
  const storage = registry[DEFAULT]
  if (!storage) throw new CalderaError('no_storage', 'No storage is configured. Add storageProvider() to the app.')
  return storage
}

const isRef = (value: unknown): value is FileRef => typeof value === 'object' && value !== null && typeof (value as FileRef).disk === 'string' && typeof (value as FileRef).key === 'string'

/** The public URL of a stored file (its disk needs `publicUrls`). */
export function fileUrl(ref: FileRef, storage: StorageLike = defaultStorage()): string {
  return storage.disk(ref.disk).url(ref.key)
}

/** An expiring download URL for a stored file, named as the user's original file. */
export function temporaryFileUrl(ref: FileRef, expiresIn: Duration, storage: StorageLike = defaultStorage()): Promise<string> {
  return storage.disk(ref.disk).temporaryUrl(ref.key, expiresIn, { downloadAs: ref.name })
}

/**
 * Streams a stored file from the app, named as the user's original file:
 * `return fileResponse(attachment.file)` after checking who may see it. `inline` shows it in the
 * browser instead of downloading it (only for kinds that are safe to render, which zfile ensures).
 */
export function fileResponse(ref: FileRef, options: { inline?: boolean; cacheControl?: string } = {}, storage: StorageLike = defaultStorage()): Promise<Response> {
  return storage.disk(ref.disk).response(ref.key, { cacheControl: options.cacheControl ?? 'private, max-age=0', ...(options.inline ? {} : { downloadAs: ref.name }) })
}

/**
 * Model hooks that delete a file column's old object once the change commits: when the row points
 * at a new file, or is deleted for good (a soft delete keeps the file, so a restore still has it).
 * `defineModel(posts, { hooks: { ...cleanupFiles('cover', 'attachment') } })`.
 */
export function cleanupFiles<C extends string>(...columns: C[]) {
  const remove = async (refs: unknown[]) => {
    const storage = defaultStorage()
    for (const ref of refs) {
      if (!isRef(ref)) continue
      try {
        await storage.disk(ref.disk).delete(ref.key)
      } catch (error) {
        // The row change already committed; a leftover object is logged, not thrown at the caller.
        console.error(`[caldera] couldn't delete ${ref.disk}:${ref.key}`, error)
      }
    }
  }
  return {
    updated: async ({ before, after }: { before: Partial<Record<C, unknown>>; after: Partial<Record<C, unknown>> }) => {
      await remove(columns.filter((c) => isRef(before[c]) && (!isRef(after[c]) || (after[c] as FileRef).key !== (before[c] as FileRef).key)).map((c) => before[c]))
    },
    deleted: async (row: Partial<Record<C, unknown>>, info?: { soft: boolean }) => {
      if (info?.soft) return
      await remove(columns.map((c) => row[c]))
    },
  }
}

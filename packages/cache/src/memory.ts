import { defineDriver } from '@caldera-js/core'
import { gcra } from './gcra.js'
import type { CacheCapabilities, CacheStore, ThrottleRequest, ThrottleResult } from './store.js'

interface Entry {
  value: string
  expiresAt: number | undefined
}

/**
 * An in-process store: exact and atomic (JavaScript is single-threaded), but per process. Right for
 * tests, development and single-instance apps; not shared between servers or serverless invocations.
 */
export function memoryStore(options: { now?: () => number } = {}): CacheStore {
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  const read = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      entries.delete(key)
      return undefined
    }
    return entry
  }
  const write = (key: string, value: string, ttl?: number) => {
    entries.set(key, { value, expiresAt: ttl === undefined ? undefined : now() + ttl * 1000 })
  }

  return {
    async get(key) {
      return read(key)?.value
    },
    async put(key, value, ttl) {
      write(key, value, ttl)
    },
    async add(key, value, ttl) {
      if (read(key)) return false
      write(key, value, ttl)
      return true
    },
    async forget(key) {
      return entries.delete(key)
    },
    async forgetIf(key, expected) {
      if (read(key)?.value !== expected) return false
      return entries.delete(key)
    },
    async increment(key, by, ttl) {
      const entry = read(key)
      const value = (entry ? Number(entry.value) : 0) + by
      entries.set(key, { value: String(value), expiresAt: entry ? entry.expiresAt : ttl === undefined ? undefined : now() + ttl * 1000 })
      return value
    },
    async throttle(request: ThrottleRequest): Promise<ThrottleResult> {
      const at = now()
      const results = request.limits.map((limit) => gcra(limit, numberOrUndefined(read(limit.key)?.value), at, request.cost))
      const allowed = results.every((r) => r.allowed)
      if (allowed && !request.peek) {
        request.limits.forEach((limit, i) => {
          const tat = results[i]!.tat
          entries.set(limit.key, { value: String(tat), expiresAt: Math.ceil(tat) })
        })
      }
      return { allowed, limits: results.map(({ allowed: _a, tat: _t, ...rest }) => rest) }
    },
    async flush(prefix) {
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key)
    },
  }
}

const numberOrUndefined = (value: string | undefined) => (value === undefined ? undefined : Number(value))

export const memoryDriver = defineDriver<CacheStore, CacheCapabilities>({
  name: 'memory',
  capabilities: { locks: true, atomicCounters: true, consistentReads: true, shared: false },
  create: () => memoryStore(),
})

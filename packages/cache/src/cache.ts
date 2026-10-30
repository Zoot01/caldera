import { CalderaError, parseDuration, type Duration } from '@caldera/core'
import type { z } from 'zod'
import type { CacheCapabilities, CacheStore } from './store.js'

export interface ReadOptions<T> {
  /**
   * Validates (and coerces) what comes back, e.g. `z.object({ at: z.coerce.date() })`. A value that
   * no longer matches (its shape changed in a deploy) counts as a miss instead of a crash.
   */
  schema?: z.ZodType<T>
}

export interface FlexibleOptions<T> extends ReadOptions<T> {
  /** Keeps the background refresh alive after the response (Workers: `c.executionCtx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void
}

export interface Lock {
  readonly name: string
  /** A random token: only the holder can release the lock. */
  readonly owner: string
  acquire(): Promise<boolean>
  release(): Promise<boolean>
  /**
   * Runs `fn` while holding the lock and always releases it. Waits up to `wait` for the lock
   * (default: don't wait), then throws `LockUnavailableError`.
   */
  run<T>(fn: () => Promise<T> | T, options?: { wait?: Duration }): Promise<T>
}

export class LockUnavailableError extends CalderaError {
  constructor(name: string) {
    super('lock_unavailable', `The lock "${name}" is held by someone else.`, { name })
  }
}

export interface Cache {
  /** The store's name in config, e.g. `redis`. */
  readonly store: string
  readonly capabilities: CacheCapabilities
  get<T = unknown>(key: string, options?: ReadOptions<T>): Promise<T | undefined>
  has(key: string): Promise<boolean>
  /** Stores a JSON value; no `ttl` means forever. */
  put(key: string, value: unknown, ttl?: Duration): Promise<void>
  /** Stores only if absent; true when stored. */
  add(key: string, value: unknown, ttl?: Duration): Promise<boolean>
  forget(key: string): Promise<boolean>
  pull<T = unknown>(key: string, options?: ReadOptions<T>): Promise<T | undefined>
  increment(key: string, by?: number, ttl?: Duration): Promise<number>
  decrement(key: string, by?: number): Promise<number>
  /** The cached value, or `compute()`'s result, stored for `ttl`. */
  remember<T>(key: string, ttl: Duration, compute: () => Promise<T> | T, options?: ReadOptions<T>): Promise<T>
  rememberForever<T>(key: string, compute: () => Promise<T> | T, options?: ReadOptions<T>): Promise<T>
  /**
   * Stale-while-revalidate: fresh for `fresh`, then served stale for up to `stale` while one caller
   * refreshes it in the background. After `stale` it's computed again before returning.
   */
  flexible<T>(key: string, ttl: [fresh: Duration, stale: Duration], compute: () => Promise<T> | T, options?: FlexibleOptions<T>): Promise<T>
  /** A lock held for at most `ttl` (it expires if the holder dies). Needs a store with `locks`. */
  lock(name: string, ttl: Duration): Lock
  /** The same cache, with keys grouped under tags you can flush together. */
  tags(...names: string[]): Cache & { flush(): Promise<void> }
  /** Deletes every key of this cache (its prefix only, never the whole store). */
  flush(): Promise<void>
}

export interface CreateCacheOptions {
  name: string
  store: CacheStore
  capabilities: CacheCapabilities
  /** Prepended to every key, so apps (and tests) sharing a Redis don't collide. Default `caldera`. */
  prefix?: string
}

export function createCache(options: CreateCacheOptions): Cache {
  // Never empty: flush() deletes by prefix, and an empty one would mean the whole store.
  return build(options, `${options.prefix || 'caldera'}:`, async (key) => key)
}

function build(options: CreateCacheOptions, prefix: string, scopeKey: (key: string) => Promise<string>): Cache {
  const { store, capabilities } = options
  const k = async (key: string) => prefix + (await scopeKey(key))
  const ttlOf = (ttl: Duration | undefined) => (ttl === undefined ? undefined : parseDuration(ttl))

  const decode = <T>(raw: string | undefined, schema?: z.ZodType<T>): { hit: boolean; value: T | undefined } => {
    if (raw === undefined) return { hit: false, value: undefined }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return { hit: false, value: undefined }
    }
    if (!schema) return { hit: true, value: value as T }
    const parsed = schema.safeParse(value)
    return parsed.success ? { hit: true, value: parsed.data } : { hit: false, value: undefined }
  }
  const encode = (value: unknown) => {
    if (value === undefined) throw new CalderaError('cache_undefined', "Can't cache undefined; use null for \"nothing\".")
    return JSON.stringify(value)
  }

  const cache: Cache = {
    store: options.name,
    capabilities,
    async get(key, opts) {
      return decode(await store.get(await k(key)), opts?.schema).value
    },
    async has(key) {
      return (await store.get(await k(key))) !== undefined
    },
    async put(key, value, ttl) {
      await store.put(await k(key), encode(value), ttlOf(ttl))
    },
    async add(key, value, ttl) {
      return store.add(await k(key), encode(value), ttlOf(ttl))
    },
    async forget(key) {
      return store.forget(await k(key))
    },
    async pull(key, opts) {
      const full = await k(key)
      const { value } = decode(await store.get(full), opts?.schema)
      await store.forget(full)
      return value as never
    },
    async increment(key, by = 1, ttl) {
      return store.increment(await k(key), by, ttlOf(ttl))
    },
    async decrement(key, by = 1) {
      return store.increment(await k(key), -by)
    },
    async remember(key, ttl, compute, opts) {
      const full = await k(key)
      const cached = decode(await store.get(full), opts?.schema)
      if (cached.hit) return cached.value as never
      const value = await compute()
      await store.put(full, encode(value), ttlOf(ttl))
      return value
    },
    async rememberForever(key, compute, opts) {
      const full = await k(key)
      const cached = decode(await store.get(full), opts?.schema)
      if (cached.hit) return cached.value as never
      const value = await compute()
      await store.put(full, encode(value))
      return value
    },
    async flexible(key, [fresh, stale], compute, opts = {}) {
      const full = await k(key)
      const freshMs = parseDuration(fresh) * 1000
      const staleSeconds = parseDuration(stale)
      const stored = decode<{ v: unknown; at: number }>(await store.get(full))
      const schema = opts.schema
      const value = stored.hit && stored.value ? (schema ? schema.safeParse(stored.value.v) : { success: true as const, data: stored.value.v }) : undefined
      const save = async () => {
        const next = await compute()
        await store.put(full, JSON.stringify({ v: next, at: Date.now() }), staleSeconds)
        return next
      }
      if (!value?.success) return save()
      if (Date.now() - stored.value!.at < freshMs) return value.data as never
      // Stale: serve it now; one caller (across servers, with a shared store) refreshes it.
      const refresh = (async () => {
        if (!(await store.add(`${full}:refreshing`, '1', Math.max(1, freshMs / 1000)))) return
        try {
          await save()
        } finally {
          await store.forget(`${full}:refreshing`)
        }
      })().catch((error: unknown) => console.error(`cache.flexible("${key}") refresh failed`, error))
      opts.waitUntil?.(refresh)
      return value.data as never
    },
    lock(name, ttl) {
      if (!capabilities.locks) {
        throw new CalderaError('capability_missing', `The "${options.name}" cache store can't hold locks (its writes aren't atomic). Use Redis, or the memory store in development.`, {
          store: options.name,
          capability: 'locks',
        })
      }
      const owner = crypto.randomUUID()
      const seconds = parseDuration(ttl)
      const lockKey = `${prefix}lock:${name}`
      const lock: Lock = {
        name,
        owner,
        acquire: () => store.add(lockKey, owner, seconds),
        release: () => store.forgetIf(lockKey, owner),
        async run(fn, { wait } = {}) {
          const deadline = Date.now() + (wait === undefined ? 0 : parseDuration(wait) * 1000)
          while (!(await lock.acquire())) {
            if (Date.now() >= deadline) throw new LockUnavailableError(name)
            await new Promise((r) => setTimeout(r, 50))
          }
          try {
            return await fn()
          } finally {
            await lock.release()
          }
        },
      }
      return lock
    },
    tags(...names) {
      // Emulated on every store: each tag has a version, and flushing a tag bumps it, so its old
      // keys are never read again (they expire on their own).
      const versionKey = (tag: string) => `${prefix}tag:${tag}`
      const versions = async () => {
        const parts: string[] = []
        for (const tag of [...names].sort()) {
          let version = await store.get(versionKey(tag))
          if (version === undefined) {
            const fresh = crypto.randomUUID().slice(0, 8)
            version = (await store.add(versionKey(tag), fresh)) ? fresh : ((await store.get(versionKey(tag))) ?? fresh)
          }
          parts.push(`${tag}@${version}`)
        }
        return parts.join(',')
      }
      const tagged = build(options, prefix, async (key) => `tagged:${await versions()}:${await scopeKey(key)}`)
      return Object.assign(tagged, {
        async flush() {
          for (const tag of names) await store.put(versionKey(tag), crypto.randomUUID().slice(0, 8))
        },
      })
    },
    async flush() {
      await store.flush(prefix)
    },
  }
  return cache
}

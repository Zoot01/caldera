/**
 * What a cache driver implements: raw string values and a few atomic operations. The `Cache` on
 * top adds JSON, schemas, TTL parsing, locks, tags and stale-while-revalidate, once for every driver.
 * TTLs are seconds; `undefined` means forever.
 */
export interface CacheStore {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string, ttl?: number): Promise<void>
  /** Sets the key only if it's absent. Atomic where `locks` is true. */
  add(key: string, value: string, ttl?: number): Promise<boolean>
  forget(key: string): Promise<boolean>
  /** Deletes the key only if it still holds `expected` (releasing a lock you own). */
  forgetIf(key: string, expected: string): Promise<boolean>
  /** Adds `by`, creating the key at 0 (with `ttl`) if absent. Atomic where `atomicCounters` is true. */
  increment(key: string, by: number, ttl?: number): Promise<number>
  /** Rate limiting: checks several limits and consumes all of them, or none, in one atomic step. */
  throttle?(request: ThrottleRequest): Promise<ThrottleResult>
  /** Deletes every key that starts with `prefix`. Never the whole database. */
  flush(prefix: string): Promise<void>
}

export interface CacheCapabilities {
  /** `add` is atomic, so locks are safe. */
  locks: boolean
  /** `increment` and `throttle` are atomic. Required by rate limiting and queue batches. */
  atomicCounters: boolean
  /** A write is visible to the next read everywhere (false on Cloudflare KV). */
  consistentReads: boolean
  /** Shared between processes and servers (false for the memory store). */
  shared: boolean
}

export interface ThrottleLimit {
  key: string
  /** Requests allowed per period. */
  limit: number
  periodMs: number
}

export interface ThrottleRequest {
  limits: ThrottleLimit[]
  /** How many units this request uses. */
  cost: number
  /** Check without consuming. */
  peek?: boolean
}

export interface ThrottleLimitResult {
  limit: number
  /** Requests left right now (after this one, when it was allowed). */
  remaining: number
  /** Until this limit is completely fresh again. */
  resetAfterMs: number
  /** Until a request of the same cost would be allowed (0 when allowed). */
  retryAfterMs: number
}

export interface ThrottleResult {
  allowed: boolean
  limits: ThrottleLimitResult[]
}

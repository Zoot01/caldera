import { CalderaError, type Duration } from '@caldera/core'
import type { JobContext, JobMiddleware } from './job.js'

/** A cache that can hold locks, e.g. `c.var.cache` from `@caldera/cache`. */
interface LockingCache {
  readonly capabilities: { locks: boolean }
  lock(name: string, ttl: Duration): { acquire(): Promise<boolean>; release(): Promise<boolean> }
}

/** A limiter from `defineLimiter()` in `@caldera/cache`. */
interface LimiterLike {
  readonly name: string
  attempt(cache: never, key: string | readonly string[]): Promise<{ allowed: boolean; limits: { retryAfterMs: number }[] }>
}

const cacheOf = <T>(context: JobContext, store: ((services: never) => T) | undefined, what: string): T => {
  const cache = store ? store(context.services as never) : (context.services as { cache?: T }).cache
  if (!cache) throw new CalderaError('cache_not_configured', `${what} needs a cache: add cacheProvider() to the app, or pass \`store\`.`)
  return cache
}

/**
 * At most one job with the same key runs at a time (Laravel's WithoutOverlapping). A job that finds
 * the lock taken is released to try again after `releaseAfter`; that counts as an attempt, so give
 * such jobs enough `tries` or a `retryUntil`. The lock expires after `expiresAfter` if a worker dies.
 */
export function withoutOverlapping<P = any>(
  options: { key?: (payload: P) => string; releaseAfter?: Duration; expiresAfter?: Duration; store?: (services: never) => LockingCache } = {},
): JobMiddleware {
  return async (context, next) => {
    const cache = cacheOf(context, options.store, 'withoutOverlapping()')
    const key = `overlap:${context.job.name}:${options.key ? options.key(context.payload as P) : ''}`
    const lock = cache.lock(key, options.expiresAfter ?? context.job.timeout + 60)
    if (!(await lock.acquire())) context.release(options.releaseAfter ?? 5)
    try {
      await next()
    } finally {
      await lock.release()
    }
  }
}

/**
 * Runs the job only while the limiter allows it (Laravel's RateLimited), e.g. to respect a third
 * party's API limits across all workers. Otherwise the job is released until the limiter has room.
 * Like any release, it counts as an attempt.
 */
export function rateLimited<P = any>(limiter: LimiterLike, options: { key?: (payload: P) => string | readonly string[]; store?: (services: never) => unknown } = {}): JobMiddleware {
  return async (context, next) => {
    const cache = cacheOf(context, options.store, 'rateLimited()')
    const result = await limiter.attempt(cache as never, options.key ? options.key(context.payload as P) : context.job.name)
    if (!result.allowed) context.release(Math.max(1, Math.ceil(Math.max(...result.limits.map((l) => l.retryAfterMs), 0) / 1000)))
    await next()
  }
}


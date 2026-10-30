import { CalderaError, parseDuration, type Duration } from '@caldera/core'
import type { Context, MiddlewareHandler } from 'hono'
import type { Cache } from './cache.js'
import type { ThrottleResult } from './store.js'

export interface Limit {
  limit: number
  /** Seconds. */
  period: number
}

/** `limit` requests per `period`, refilling smoothly (GCRA), with bursts up to `limit`. */
export const every = (limit: number, period: Duration): Limit => ({ limit, period: parseDuration(period) })
export const perSecond = (limit: number) => every(limit, 1)
export const perMinute = (limit: number) => every(limit, 60)
export const perHour = (limit: number) => every(limit, 3600)
export const perDay = (limit: number) => every(limit, 86400)

type KeyPart = string | number | null | undefined

export interface LimiterOptions {
  limits: readonly Limit[]
  /**
   * Who is limited. Default: the signed-in user's id, else the client IP (`ipOf(c)`). Return parts to
   * combine them, e.g. `[ipOf(c), email]` for logins.
   */
  key?: (c: Context) => KeyPart | readonly KeyPart[] | Promise<KeyPart | readonly KeyPart[]>
  /** `failures` counts only responses with status >= 400 (failed logins), like Laravel's `after()`. */
  count?: 'all' | 'failures'
  /** Once a limit is hit, refuse everything from this key for this long. */
  blockFor?: Duration
  /** Units a request uses. Default 1. */
  cost?: number
  /** Cache store to count in. Default: the default store. It needs atomic counters (memory, Redis). */
  store?: string
  /** Set headers and log, but never refuse: for trying out limits in production. */
  dryRun?: boolean
  /** The message on a 429. */
  message?: string
}

export interface LimiterDescription {
  name: string
  limits: { limit: number; periodSeconds: number }[]
  algorithm: 'gcra'
  count: 'all' | 'failures'
  key: 'custom' | 'user-or-ip'
  store: string | null
  blockForSeconds: number | null
  dryRun: boolean
  source?: { file: string; line: number }
}

export interface Limiter {
  readonly kind: 'caldera.limiter'
  readonly name: string
  /** The Hono middleware. Routes take the limiter itself: `{ throttle: loginLimiter }`. */
  middleware(): MiddlewareHandler
  /** Outside HTTP (a job, a CLI): consumes one attempt for `key`, and reports the result. */
  attempt(cache: Cache, key: KeyPart | readonly KeyPart[], options?: { peek?: boolean }): Promise<ThrottleResult & { blocked: boolean }>
  /** Clears a key's counters and block, e.g. after a successful login. */
  reset(cache: Cache, key: KeyPart | readonly KeyPart[]): Promise<void>
  describe(): LimiterDescription
}

/**
 * Thrown on a refused request. `@caldera/http`'s error handler turns it into the 429 envelope with
 * `Retry-After` and `X-RateLimit-*` headers (or, for an Inertia form post, a redirect back with the error).
 */
export class RateLimitedError extends CalderaError {
  declare readonly details: { limiter: string; retryAfter: number; headers: Record<string, string> }

  constructor(limiter: string, message: string, retryAfter: number, headers: Record<string, string>) {
    super('rate_limited', message, { limiter, retryAfter, headers })
  }
}

export function defineLimiter(name: string, options: LimiterOptions): Limiter {
  if (options.limits.length === 0) throw new CalderaError('limiter_invalid', `Limiter "${name}" needs at least one limit.`)
  const count = options.count ?? 'all'
  const cost = options.cost ?? 1
  const blockFor = options.blockFor === undefined ? undefined : parseDuration(options.blockFor)
  const source = callerSource()

  const keyOf = (parts: KeyPart | readonly KeyPart[]) => (Array.isArray(parts) ? parts : [parts]).map((p) => String(p ?? '-')).join('|')
  const limitKeys = (key: string) => options.limits.map((l) => ({ key: `limiter:${name}:${key}:${l.limit}/${l.period}`, limit: l.limit, periodMs: l.period * 1000 }))
  const blockKey = (key: string) => `limiter:${name}:${key}:blocked`

  /** Seconds left on a block, or 0. */
  const blockedFor = async (cache: Cache, key: string) => {
    if (blockFor === undefined) return 0
    const until = await cache.get<number>(blockKey(key))
    return until === undefined ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000))
  }
  const block = async (cache: Cache, key: string) => {
    if (blockFor !== undefined) await cache.put(blockKey(key), Date.now() + blockFor * 1000, blockFor)
  }

  const run = async (cache: Cache, key: string, peek: boolean) => {
    const blocked = await blockedFor(cache, key)
    if (blocked > 0) return { allowed: false, blocked: true, retryAfter: blocked, result: undefined }
    const result = await cache.throttle({ limits: limitKeys(key), cost, peek })
    if (!result.allowed) await block(cache, key)
    const retryAfter = Math.ceil(Math.max(blockFor ?? 0, ...result.limits.map((l) => l.retryAfterMs / 1000)))
    return { allowed: result.allowed, blocked: false, retryAfter: result.allowed ? 0 : retryAfter, result }
  }

  const limiter: Limiter = {
    kind: 'caldera.limiter',
    name,
    middleware() {
      return async (c, next) => {
        const cache = cacheOf(c, options.store)
        const key = keyOf(options.key ? await options.key(c) : defaultKey(c))
        // Failures are counted after the response; before it, only check there's room for one more.
        const outcome = await run(cache, key, count === 'failures')
        const headers = rateHeaders(outcome.result, outcome.retryAfter)
        if (!outcome.allowed) {
          if (!options.dryRun) throw new RateLimitedError(name, options.message ?? 'Too many requests. Try again later.', outcome.retryAfter, headers)
          console.warn(`[caldera] limiter "${name}" would refuse ${key} (dry run)`)
        }
        await next()
        for (const [header, value] of Object.entries(headers)) if (!header.startsWith('retry') && !c.res.headers.has(header)) safeSet(c, header, value)
        if (count === 'failures' && c.res.status >= 400 && c.res.status !== 429) {
          const result = await cache.throttle({ limits: limitKeys(key), cost })
          if (!result.allowed) await block(cache, key)
        }
      }
    },
    async attempt(cache, parts, { peek = false } = {}) {
      const outcome = await run(cache, keyOf(parts), peek)
      return { allowed: outcome.allowed, blocked: outcome.blocked, limits: outcome.result?.limits ?? [] }
    },
    async reset(cache, parts) {
      const key = keyOf(parts)
      for (const l of limitKeys(key)) await cache.forget(l.key)
      await cache.forget(blockKey(key))
    },
    describe: () => ({
      name,
      limits: options.limits.map((l) => ({ limit: l.limit, periodSeconds: l.period })),
      algorithm: 'gcra',
      count,
      key: options.key ? 'custom' : 'user-or-ip',
      store: options.store ?? null,
      blockForSeconds: blockFor ?? null,
      dryRun: options.dryRun ?? false,
      ...(source ? { source } : {}),
    }),
  }
  return limiter
}

/** The most restrictive limit is the one reported, as Laravel does with several limits. */
function rateHeaders(result: ThrottleResult | undefined, retryAfter: number): Record<string, string> {
  const headers: Record<string, string> = {}
  const tightest = result?.limits.reduce((a, b) => (b.remaining < a.remaining ? b : a))
  if (tightest) {
    headers['x-ratelimit-limit'] = String(tightest.limit)
    headers['x-ratelimit-remaining'] = String(tightest.remaining)
  }
  if (retryAfter > 0) {
    headers['retry-after'] = String(retryAfter)
    headers['x-ratelimit-reset'] = String(Math.ceil(Date.now() / 1000) + retryAfter)
  }
  return headers
}

function cacheOf(c: Context, store: string | undefined): Cache {
  const cache = (c.var as { cache?: Cache & { store(name: string): Cache } }).cache
  if (!cache) throw new CalderaError('cache_not_configured', 'Rate limiting needs cacheProvider() in the app (it counts in the cache).')
  return store ? cache.store(store) : cache
}

function defaultKey(c: Context): KeyPart[] {
  const user = (c.var as { user?: { id?: unknown } | null }).user
  return user?.id !== undefined && user.id !== null ? ['user', String(user.id)] : ['ip', ipOf(c)]
}

/**
 * The client's IP, as far as the runtime can tell without trusting spoofable headers: `c.var.ip`
 * if your app sets it (e.g. from a trusted proxy's header), Cloudflare's `CF-Connecting-IP`, or
 * the socket address on Node. Behind another proxy, set `c.var.ip` yourself, or every client
 * shares one bucket.
 */
export function ipOf(c: Context): string {
  const fromVar = (c.var as { ip?: unknown }).ip
  if (typeof fromVar === 'string' && fromVar) return fromVar
  const cf = c.req.header('cf-connecting-ip')
  if (cf) return cf
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  return socket ?? 'unknown'
}

function safeSet(c: Context, name: string, value: string) {
  try {
    c.res.headers.set(name, value)
  } catch {
    c.res = new Response(c.res.body, c.res)
    c.res.headers.set(name, value)
  }
}

function callerSource(): { file: string; line: number } | undefined {
  for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
    const match = frame.match(/\(?((?:file:\/\/)?[^\s()]+?):(\d+):\d+\)?\s*$/)
    if (!match) continue
    // Loaders (tsx) give modules URLs with a query and percent-encoding: keep just the path.
    const file = decodeURIComponent(match[1]!.replace(/^file:\/\//, '').replace(/\?.*$/, ''))
    if (file.includes('/packages/cache/src/') || file.includes('/packages/cache/dist/') || file.includes('/@caldera/cache/') || file.startsWith('node:') || file.includes('/node_modules/')) continue
    return { file, line: Number(match[2]) }
  }
  return undefined
}

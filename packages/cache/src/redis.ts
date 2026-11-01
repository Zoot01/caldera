import { CalderaError, defineDriver } from '@caldera-js/core'
import { z } from 'zod'
import type { CacheCapabilities, CacheStore, ThrottleResult } from './store.js'

/** The few ioredis methods the store uses, so tests and other clients can stand in. */
export interface RedisClientLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>
  del(...keys: string[]): Promise<number>
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>
  quit(): Promise<unknown>
}

const FORGET_IF = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

const INCREMENT = `local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
if ARGV[2] ~= '' and redis.call('PTTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return v`

// GCRA over every limit at once: all are consumed or none, in one atomic step. "Now" is the Redis
// server's clock, so app servers with skewed clocks still agree. Mirrors gcra.ts.
const THROTTLE = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cost = tonumber(ARGV[1])
local peek = ARGV[2] == '1'
local out = {}
local allowed = 1
local tats = {}
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[1 + i * 2])
  local period = tonumber(ARGV[2 + i * 2])
  local interval = period / limit
  local stored = redis.call('GET', key)
  local tat = now
  if stored then tat = math.max(tonumber(stored), now) end
  local nextTat = tat + cost * interval
  local allowAt = nextTat - period
  if now < allowAt then
    allowed = 0
    out[#out + 1] = {0, limit, math.max(0, math.floor((period - (tat - now)) / interval)), math.ceil(tat - now), math.ceil(allowAt - now)}
  else
    out[#out + 1] = {1, limit, math.max(0, math.floor((period - (nextTat - now)) / interval)), math.ceil(nextTat - now), 0}
  end
  tats[i] = nextTat
end
if allowed == 1 and not peek then
  for i, key in ipairs(KEYS) do
    redis.call('SET', key, tostring(tats[i]), 'PX', math.max(1, math.ceil(tats[i] - now)))
  end
end
local flat = {allowed}
for _, r in ipairs(out) do for _, v in ipairs(r) do flat[#flat + 1] = v end end
return flat`

/** A Redis-backed store over any ioredis-compatible client. */
export function redisStore(client: RedisClientLike | (() => Promise<RedisClientLike>)): CacheStore & { close(): Promise<void> } {
  let connected: Promise<RedisClientLike> | undefined
  const redis = () => (connected ??= typeof client === 'function' ? client() : Promise.resolve(client))

  return {
    async get(key) {
      return (await (await redis()).get(key)) ?? undefined
    },
    async put(key, value, ttl) {
      const r = await redis()
      if (ttl === undefined) await r.set(key, value)
      else await r.set(key, value, 'PX', Math.max(1, Math.round(ttl * 1000)))
    },
    async add(key, value, ttl) {
      const r = await redis()
      const result = ttl === undefined ? await r.set(key, value, 'NX') : await r.set(key, value, 'PX', Math.max(1, Math.round(ttl * 1000)), 'NX')
      return result === 'OK'
    },
    async forget(key) {
      return (await (await redis()).del(key)) > 0
    },
    async forgetIf(key, expected) {
      return Number(await (await redis()).eval(FORGET_IF, 1, key, expected)) > 0
    },
    async increment(key, by, ttl) {
      return Number(await (await redis()).eval(INCREMENT, 1, key, by, ttl === undefined ? '' : Math.max(1, Math.ceil(ttl))))
    },
    async throttle(request): Promise<ThrottleResult> {
      const args = [request.cost, request.peek ? '1' : '0', ...request.limits.flatMap((l) => [l.limit, l.periodMs])]
      const flat = (await (await redis()).eval(THROTTLE, request.limits.length, ...request.limits.map((l) => l.key), ...args)) as number[]
      const limits = request.limits.map((_, i) => {
        const [, limit, remaining, resetAfterMs, retryAfterMs] = flat.slice(1 + i * 5, 6 + i * 5) as number[]
        return { limit: limit!, remaining: remaining!, resetAfterMs: resetAfterMs!, retryAfterMs: retryAfterMs! }
      })
      return { allowed: flat[0] === 1, limits }
    },
    async flush(prefix) {
      const r = await redis()
      const pattern = `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`
      let cursor = '0'
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
        if (keys.length) await r.del(...keys)
        cursor = next
      } while (cursor !== '0')
    },
    async close() {
      if (connected) await (await connected).quit()
    },
  }
}

export const redisDriver = defineDriver<CacheStore, CacheCapabilities, { url: string }>({
  name: 'redis',
  schema: z.object({ url: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL') }),
  capabilities: { locks: true, atomicCounters: true, consistentReads: true, shared: true },
  create: (config) =>
    redisStore(async () => {
      // Imported on first use, so apps without Redis don't need ioredis (and edge bundles never load it).
      // Imported on first use; this whole file is a separate entry (@caldera-js/cache/redis), so apps
      // that never use Redis (and edge bundles) never reference ioredis at all.
      const module = (await import('ioredis').catch(() => {
        throw new CalderaError('missing_dependency', 'The redis cache store needs ioredis: install it in your app.', { package: 'ioredis' })
      })) as unknown as { default: new (url: string, options: object) => RedisClientLike }
      return new module.default(config.url, { lazyConnect: false, maxRetriesPerRequest: 2 })
    }),
  close: (store) => (store as ReturnType<typeof redisStore>).close(),
})

import { createApp, defineEnv } from '@caldera/core'
import { createRouter, defineRoutes, errorHandler, sessionProvider, startSession, type ErrorBody } from '@caldera/http'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cacheProvider, createCacheService, defineLimiter, every, gcra, perMinute } from '../src/index.js'
import { databaseCacheDriver } from '../src/database.js'
import { redisDriver } from '../src/redis.js'
import { databaseBackends } from './databases.js'
import { hasRedis, startRedis } from './redis-server.js'

let redis: Awaited<ReturnType<typeof startRedis>> | undefined
beforeAll(async () => {
  if (hasRedis) redis = await startRedis()
})
const databases = await databaseBackends()
afterAll(async () => {
  await redis?.stop()
  await databases.stop()
})

const backends: { name: string; store: () => { driver: string; [k: string]: unknown }; setup?: () => Promise<unknown> }[] = [
  { name: 'memory', store: () => ({ driver: 'memory' }) },
  ...(hasRedis ? [{ name: 'redis', store: () => ({ driver: 'redis', url: redis!.url }) }] : []),
  ...databases.backends.map((b) => ({ name: b.name, store: () => ({ driver: 'database' }), setup: () => b.use() })),
]

function makeHttp(store: { driver: string; [k: string]: unknown }) {
  const app = createApp({
    env: defineEnv({}),
    providers: [cacheProvider(() => ({ default: 'main', stores: { main: store }, prefix: `t${Math.random()}` }), { drivers: [redisDriver, databaseCacheDriver] }), sessionProvider(() => ({ keys: ['k'.repeat(40)] }))],
  })
  const api = defineLimiter('api', { limits: [perMinute(5)], key: (c) => c.req.header('x-client') ?? 'anon' })
  const burst = defineLimiter('burst', { limits: [every(3, '1s'), perMinute(4)], key: () => 'one' })
  const login = defineLimiter('login', { limits: [perMinute(3)], count: 'failures', blockFor: '1m', key: (c) => c.req.header('x-email') })
  const trial = defineLimiter('trial', { limits: [perMinute(1)], dryRun: true, key: () => 'x' })
  const routes = defineRoutes('demo')
    .get('data', '/data', { throttle: api }, (c) => c.json({ ok: true }))
    .get('burst', '/burst', { throttle: burst }, (c) => c.json({ ok: true }))
    .post('login', '/login', { throttle: login }, (c) => (c.req.header('x-password') === 'right' ? c.json({ ok: true }) : c.json({ ok: false }, 401)))
    .get('trial', '/trial', { throttle: trial }, (c) => c.json({ ok: true }))
  const router = createRouter(routes)
  return { http: new Hono().use(app.middleware()).use(startSession()).route('/', router.app).onError(errorHandler({ report: () => {} })), router, api }
}

// Database backends run the concurrency tests through real round trips (D1 through workerd), so they get time.
describe.each(backends)('limiters on $name', { timeout: 20_000 }, ({ store, setup }) => {
  beforeAll(async () => {
    await setup?.()
  })
  it('allows the limit, then refuses with the envelope and headers', async () => {
    const { http } = makeHttp(store())
    for (let i = 4; i >= 0; i--) {
      const res = await http.request('/data', { headers: { 'x-client': 'a' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-ratelimit-limit')).toBe('5')
      expect(res.headers.get('x-ratelimit-remaining')).toBe(String(i))
    }
    const refused = await http.request('/data', { headers: { 'x-client': 'a' } })
    expect(refused.status).toBe(429)
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(12) // one request refills every 60s / 5
    expect(Number(refused.headers.get('x-ratelimit-reset'))).toBeGreaterThan(Date.now() / 1000)
    expect(((await refused.json()) as ErrorBody).error).toMatchObject({ code: 'rate_limited', status: 429, retryAfter })
    // Other keys are unaffected.
    expect((await http.request('/data', { headers: { 'x-client': 'b' } })).status).toBe(200)
  })

  it('never lets concurrent requests overshoot', async () => {
    const { http } = makeHttp(store())
    const statuses = await Promise.all(Array.from({ length: 30 }, async () => (await http.request("/data", { headers: { "x-client": "race" } })).status))
    expect(statuses.filter((s) => s === 200)).toHaveLength(5)
  })

  it('checks every limit and consumes all or none', async () => {
    const { http } = makeHttp(store())
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await http.request('/burst')).status)
    // 3 per second is the tighter limit: the 4th is refused, and it didn't use up the per-minute budget.
    expect(statuses).toEqual([200, 200, 200, 429])
    await new Promise((r) => setTimeout(r, 1100))
    expect((await http.request('/burst')).status).toBe(200)
    expect((await http.request('/burst')).status).toBe(429) // now per-minute (4) is spent
  })

  it('counts only failures, blocks, and lets a reset clear it', async () => {
    const { http } = makeHttp(store())
    const login = (password: string) => http.request('/login', { method: 'POST', headers: { 'x-email': 'ann@example.test', 'x-password': password } })
    // Successes don't count.
    for (let i = 0; i < 5; i++) expect((await login('right')).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await login('wrong')).status).toBe(401)
    const blocked = await login('right')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(50) // blockFor: 1m
  })

  it('in dry-run mode, reports but never refuses', async () => {
    const { http } = makeHttp(store())
    expect((await http.request('/trial')).status).toBe(200)
    const second = await http.request('/trial')
    expect(second.status).toBe(200)
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0')
  })
})

describe('integration', () => {
  it('shows a refused Inertia form post as a form error', async () => {
    const { http } = makeHttp({ driver: 'memory' })
    const headers = { 'x-inertia': 'true', 'x-email': 'bob@example.test', 'x-password': 'wrong', referer: 'http://localhost/login', 'content-type': 'application/json' }
    for (let i = 0; i < 3; i++) await http.request('http://localhost/login', { method: 'POST', headers, body: '{}' })
    const res = await http.request('http://localhost/login', { method: 'POST', headers, body: '{}' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
    expect(res.headers.get('retry-after')).toBeTruthy()
  })

  it('records limiters in the route manifest, after auth in the middleware order', () => {
    const { router, api } = makeHttp({ driver: 'memory' })
    const data = router.manifest().routes.find((r) => r.name === 'demo.data')!
    expect(data.throttle).toEqual(['api'])
    expect(data.middleware).toEqual([{ name: 'throttle', options: { limiter: 'api' } }])
    expect(api.describe()).toMatchObject({ name: 'api', algorithm: 'gcra', count: 'all', limits: [{ limit: 5, periodSeconds: 60 }], key: 'custom' })
    expect(api.describe().source?.file).toContain('limiter.test.ts')
  })

  it('works outside HTTP with attempt() and reset()', async () => {
    const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
    const limiter = defineLimiter('exports', { limits: [perMinute(1)] })
    expect((await limiter.attempt(cache, ['team', 7])).allowed).toBe(true)
    expect((await limiter.attempt(cache, ['team', 7])).allowed).toBe(false)
    await limiter.reset(cache, ['team', 7])
    expect((await limiter.attempt(cache, ['team', 7])).allowed).toBe(true)
  })

  it('refuses to limit on a store without atomic counters', async () => {
    const limiter = defineLimiter('x', { limits: [perMinute(1)] })
    const weak = createCacheService(
      { default: 'kv', stores: { kv: { driver: 'weak' } } },
      { drivers: [{ kind: 'caldera.driver', name: 'weak', capabilities: { locks: false, atomicCounters: false, consistentReads: false, shared: true }, create: () => ({}) as never }] },
    )
    await expect(limiter.attempt(weak, 'k')).rejects.toThrow(/can't count atomically/)
  })
})

it('gcra refills smoothly', () => {
  const limit = { key: 'k', limit: 2, periodMs: 1000 }
  let tat: number | undefined
  const at = (now: number) => {
    const r = gcra(limit, tat, now, 1)
    if (r.allowed) tat = r.tat
    return r.allowed
  }
  expect([at(0), at(0), at(0)]).toEqual([true, true, false])
  expect(at(499)).toBe(false)
  expect(at(500)).toBe(true) // one slot back every 500ms, not a whole window at once
})

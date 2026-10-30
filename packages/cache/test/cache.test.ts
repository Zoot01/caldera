import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createCacheService, LockUnavailableError, type CacheService } from '../src/index.js'
import { redisDriver } from '../src/redis.js'
import { hasRedis, startRedis } from './redis-server.js'

let redis: Awaited<ReturnType<typeof startRedis>> | undefined
beforeAll(async () => {
  if (hasRedis) redis = await startRedis()
})
afterAll(async () => {
  await redis?.stop()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stores = [
  { name: 'memory', make: () => createCacheService({ default: 'memory', stores: { memory: { driver: 'memory' } }, prefix: `t${Math.random()}` }) },
  ...(hasRedis
    ? [{ name: 'redis', make: () => createCacheService({ default: 'redis', stores: { redis: { driver: 'redis', url: redis!.url } }, prefix: `t${Math.random()}` }, { drivers: [redisDriver] }) }]
    : []),
]

describe.each(stores)('cache on $name', ({ make }) => {
  let cache: CacheService
  beforeAll(() => {
    cache = make()
  })
  afterAll(async () => {
    await cache.manager.purge()
  })

  it('stores JSON values, with and without a TTL', async () => {
    await cache.put('user', { id: 1, tags: ['a'] })
    expect(await cache.get('user')).toEqual({ id: 1, tags: ['a'] })
    await cache.put('brief', 'x', '200ms')
    expect(await cache.has('brief')).toBe(true)
    await sleep(300)
    expect(await cache.get('brief')).toBeUndefined()
    expect(await cache.pull('user')).toEqual({ id: 1, tags: ['a'] })
    expect(await cache.has('user')).toBe(false)
    await expect(cache.put('nothing', undefined)).rejects.toThrow(/Can't cache undefined/)
  })

  it('validates on read, treating a value of the wrong shape as a miss', async () => {
    await cache.put('when', { at: '2026-10-30T00:00:00.000Z' })
    const schema = z.object({ at: z.coerce.date() })
    expect((await cache.get('when', { schema }))!.at).toBeInstanceOf(Date)
    await cache.put('shape', { old: true })
    let computed = 0
    const value = await cache.remember('shape', '1m', () => (computed++, { at: new Date(0) }), { schema })
    expect(value.at).toBeInstanceOf(Date)
    expect(computed).toBe(1)
  })

  it('remembers, computing once', async () => {
    let calls = 0
    const compute = async () => ++calls
    expect(await cache.remember('n', '1m', compute)).toBe(1)
    expect(await cache.remember('n', '1m', compute)).toBe(1)
    expect(calls).toBe(1)
  })

  it('adds only when absent, and counts atomically', async () => {
    expect(await cache.add('once', 1)).toBe(true)
    expect(await cache.add('once', 2)).toBe(false)
    const results = await Promise.all(Array.from({ length: 50 }, () => cache.increment('hits')))
    expect(Math.max(...results)).toBe(50)
    expect(await cache.decrement('hits', 10)).toBe(40)
  })

  it('serves stale values while one caller refreshes them', async () => {
    let version = 0
    const compute = async () => ++version
    const ttl: [string, string] = ['100ms', '10s']
    expect(await cache.flexible('swr', ttl as never, compute)).toBe(1)
    await sleep(150)
    let refreshed: Promise<unknown> | undefined
    // Stale: the old value comes back at once, and the refresh runs in the background.
    expect(await cache.flexible('swr', ttl as never, compute, { waitUntil: (p) => (refreshed = p) })).toBe(1)
    await refreshed
    expect(await cache.flexible('swr', ttl as never, compute)).toBe(2)
  })

  it('locks: one holder at a time, released only by its owner, expiring if abandoned', async () => {
    const a = cache.lock('report', '200ms')
    const b = cache.lock('report', '200ms')
    expect(await a.acquire()).toBe(true)
    expect(await b.acquire()).toBe(false)
    expect(await b.release()).toBe(false) // not b's lock
    await expect(b.run(() => 'x')).rejects.toBeInstanceOf(LockUnavailableError)
    // a never releases: the lock expires and b gets it while waiting.
    expect(await b.run(() => 'got it', { wait: '1s' })).toBe('got it')
    expect(await a.acquire()).toBe(true)
  })

  it('flushes tagged keys together, leaving others', async () => {
    const users = cache.tags('users')
    await users.put('list', [1, 2])
    await cache.tags('users', 'teams').put('both', true)
    await cache.put('plain', 'kept')
    await users.flush()
    expect(await users.get('list')).toBeUndefined()
    expect(await cache.tags('users', 'teams').get('both')).toBeUndefined()
    expect(await cache.get('plain')).toBe('kept')
  })

  it('flush() only removes this cache’s keys', async () => {
    const other = make()
    await other.put('mine', 1)
    await cache.put('gone', 1)
    await cache.flush()
    expect(await cache.get('gone')).toBeUndefined()
    expect(await other.get('mine')).toBe(1)
    await other.manager.purge()
  })
})

it('reports a missing store at boot and checks capabilities', () => {
  expect(() => createCacheService({ default: 'r', stores: { r: { driver: 'redis', url: 'localhost' } } }, { drivers: [redisDriver] })).toThrow(/cache\.r \(redis\): url: must be a redis:\/\//)
  // Without the driver, the error says where it is.
  expect(() => createCacheService({ default: 'r', stores: { r: { driver: 'redis', url: 'redis://x' } } })).toThrow(/It's in '@caldera\/cache\/redis'/)
  const cache = createCacheService({ default: 'memory', stores: { memory: { driver: 'memory' } } })
  expect(cache.manager.describe().instances[0]).toMatchObject({ name: 'memory', capabilities: { locks: true, shared: false } })
})

it('types the service: store(name) for other stores, name for the store’s own name', () => {
  const cache = createCacheService({ default: 'memory', stores: { memory: { driver: 'memory' }, other: { driver: 'memory' } } })
  expect(cache.name).toBe('memory')
  expect(cache.store('other').name).toBe('other')
  // @ts-expect-error not a configured store
  void (() => cache.store('missing'))
  const fn: (name: 'memory' | 'other') => unknown = cache.store
  void fn
})

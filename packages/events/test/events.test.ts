import { PGlite } from '@electric-sql/pglite'
import { cacheProvider } from '@caldera/cache'
import { createApp, defineConfig, defineEnv } from '@caldera/core'
import { createDatabase, setDefaultDatabase } from '@caldera/db'
import { createQueue, defineJob, setDefaultQueue } from '@caldera/queue'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { createEvents, defineEvent, emit, eventsProvider, listen, until } from '../src/index.js'

const log: string[] = []
afterEach(() => {
  log.length = 0
  setDefaultQueue(undefined)
})

const UserRegistered = defineEvent({ name: 'user.registered', payload: z.object({ userId: z.string(), plan: z.enum(['free', 'pro']).default('free') }) })
const first = listen(UserRegistered, (e) => void log.push(`first ${e.userId} ${e.plan}`))
const second = listen(UserRegistered, async (e, ctx) => void log.push(`second ${ctx.event} ${e.userId}`), { name: 'audit' })

describe('emit', () => {
  it('validates the payload, then runs listeners in order', async () => {
    const events = createEvents({ listeners: [first, second] })
    expect(await events.emit(UserRegistered, { userId: 'u1' })).toEqual({ listeners: 2 })
    expect(log).toEqual(['first u1 free', 'second user.registered u1'])
    // @ts-expect-error userId is required
    await expect(events.emit(UserRegistered, {})).rejects.toThrow()
    // An inline arrow has no name; codegen and AGENTS.md use the export name instead.
    expect(events.listenersFor(UserRegistered).map((l) => l.name)).toEqual(['anonymous', 'audit'])
  })

  it('stops at a listener that throws, and rejects (returning false halts nothing)', async () => {
    const no = listen(UserRegistered, () => false)
    const boom = listen(UserRegistered, () => {
      throw new Error('boom')
    })
    const after = listen(UserRegistered, () => void log.push('after'))
    await createEvents({ listeners: [no, first] }).emit(UserRegistered, { userId: 'u2' })
    expect(log).toEqual(['first u2 free'])
    await expect(createEvents({ listeners: [boom, after] }).emit(UserRegistered, { userId: 'u3' })).rejects.toThrow('boom')
    expect(log).toEqual(['first u2 free'])
  })

  it('queues a job for queued listeners, with the mapped payload', async () => {
    const SendWelcome = defineJob({ name: 'send-welcome', payload: z.object({ userId: z.string() }), handle: ({ userId }) => void log.push(`welcome ${userId}`) })
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
    setDefaultQueue(queue)
    const queued = queue.fake()
    const welcome = listen(UserRegistered, SendWelcome.fromEvent((e) => ({ userId: e.userId })))
    expect(welcome.name).toBe('send-welcome')
    await createEvents({ listeners: [welcome] }).emit(UserRegistered, { userId: 'u4' })
    queued.assertDispatched(SendWelcome, (p) => p.userId === 'u4')
    expect(log).toEqual([])
    await queued.drain()
    expect(log).toEqual(['welcome u4'])
  })

  it('says what a queued listener needs when there is no queue', async () => {
    const Job = defineJob({ name: 'j', payload: z.object({}), handle: () => {} })
    await expect(createEvents({ listeners: [listen(UserRegistered, Job.fromEvent(() => ({})))] }).emit(UserRegistered, { userId: 'x' })).rejects.toThrow(/needs a queue/)
  })
})

it('until() returns the first function listener’s answer', async () => {
  const CheckoutPrice = defineEvent({ name: 'checkout.price', payload: z.object({ sku: z.string() }) })
  const events = createEvents({
    listeners: [listen(CheckoutPrice, () => undefined), listen(CheckoutPrice, (e) => (e.sku === 'a' ? 10 : undefined)), listen(CheckoutPrice, () => 99)],
  })
  expect(await events.until<typeof CheckoutPrice, number>(CheckoutPrice, { sku: 'a' })).toBe(10)
  expect(await events.until(CheckoutPrice, { sku: 'b' })).toBe(99)
})

it('emits after the transaction commits, and not at all on rollback', async () => {
  const client = new PGlite()
  const db = createDatabase(drizzle({ client }), { driver: 'postgres' })
  setDefaultDatabase(() => db)
  try {
    const events = createEvents({ listeners: [first] })
    await db.transaction(async () => {
      await events.emit(UserRegistered, { userId: 'committed' }, { afterCommit: true })
      expect(log).toEqual([])
    })
    expect(log).toEqual(['first committed free'])
    await db
      .transaction(async () => {
        await events.emit(UserRegistered, { userId: 'rolled-back' }, { afterCommit: true })
        throw new Error('rollback')
      })
      .catch(() => {})
    expect(log).toEqual(['first committed free'])
  } finally {
    setDefaultDatabase(undefined)
    await client.close()
  }
})

it('fakes record events without running listeners', async () => {
  const Other = defineEvent({ name: 'other', payload: z.object({}) })
  const events = createEvents({ listeners: [first, listen(Other, () => void log.push('other ran'))] })
  const fake = events.fake([UserRegistered])
  await events.emit(UserRegistered, { userId: 'u5', plan: 'pro' })
  await events.emit(Other, {})
  expect(log).toEqual(['other ran'])
  fake.assertEmitted(UserRegistered, (e) => e.plan === 'pro', 1)
  fake.assertNotEmitted(UserRegistered, (e) => e.userId === 'nobody')
  expect(() => fake.assertNothingEmitted()).toThrow(/got user.registered/)
  fake.restore()
  await events.emit(UserRegistered, { userId: 'u6' })
  expect(log).toEqual(['other ran', 'first u6 free'])
})

it('eventsProvider makes emit() work and gives listeners the app’s services', async () => {
  const remember = listen(UserRegistered, async (e, ctx) => {
    await (ctx.services as unknown as { cache: { put(k: string, v: unknown): Promise<void> } }).cache.put(`user:${e.userId}`, 'seen')
  })
  const app = createApp({ env: defineEnv({}), providers: [cacheProvider(() => ({ default: 'm', stores: { m: { driver: 'memory' } } })), eventsProvider({ listeners: [remember] })] })
  await app.boot({ env: {} })
  await emit(UserRegistered, { userId: 'u7' })
  expect(await app.services.cache.get('user:u7')).toBe('seen')
  expect(await until(UserRegistered, { userId: 'u8' })).toBeUndefined()
})

it('gives listeners the app’s config', async () => {
  const urls: string[] = []
  const link = listen(UserRegistered, (e, ctx) => void urls.push(`${(ctx.config as unknown as { app: { url: string } }).app.url}/users/${e.userId}`))
  const app = createApp({ env: defineEnv({}), config: [defineConfig('app', () => ({ url: 'https://tracker.example' }))], providers: [eventsProvider({ listeners: [link] })] })
  await app.boot({ env: {} })
  await emit(UserRegistered, { userId: 'u9' })
  expect(urls).toEqual(['https://tracker.example/users/u9'])
})

it('types payloads', () => {
  listen(UserRegistered, (e) => {
    expectTypeOf(e).toEqualTypeOf<{ userId: string; plan: 'free' | 'pro' }>()
  })
  // @ts-expect-error unknown field
  void (() => emit(UserRegistered, { userId: 'x', nope: 1 }))
})

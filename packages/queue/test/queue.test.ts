import { PGlite } from '@electric-sql/pglite'
import { createApp, defineConfig, defineEnv } from '@caldera/core'
import { cacheProvider, createCacheService } from '@caldera/cache'
import { createDatabase, setDefaultDatabase } from '@caldera/db'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueue, defineJob, dispatch, queueProvider, type JobMiddleware } from '../src/index.js'

const memory = () => createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
const log: string[] = []
afterEach(() => {
  log.length = 0
})

const Greet = defineJob({
  name: 'greet',
  payload: z.object({ name: z.string() }),
  handle: ({ name }) => void log.push(`hi ${name}`),
})

const Flaky = defineJob({
  name: 'flaky',
  payload: z.object({ failTimes: z.number() }),
  tries: 4,
  backoff: [1, 10, 60],
  handle: ({ failTimes }, ctx) => {
    log.push(`attempt ${ctx.attempt}`)
    if (ctx.attempt <= failTimes) throw new Error(`boom ${ctx.attempt}`)
  },
  failed: (payload, error) => void log.push(`failed: ${(error as Error).message}`),
})

describe('defineJob', () => {
  it('needs a stable name and sensible tries', () => {
    expect(() => defineJob({ name: 'has spaces', payload: z.object({}), handle: () => {} })).toThrow(/stable id/)
    expect(() => defineJob({ name: 'x', payload: z.object({}), tries: 0, handle: () => {} })).toThrow(/tries/)
  })
})

describe('processing (memory, through the fake)', () => {
  it('retries with the job’s backoff, then succeeds', async () => {
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Flaky, { failTimes: 2 })
    const results = await fake.drain()
    expect(log).toEqual(['attempt 1', 'attempt 2', 'attempt 3'])
    expect(results.map((r) => r.outcome.status)).toEqual(['retry', 'retry', 'done'])
    expect(results.map((r) => (r.outcome.status === 'retry' ? r.outcome.delaySeconds : null))).toEqual([1, 10, null])
  })

  it('calls failed() once after the last try', async () => {
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Flaky, { failTimes: 9 })
    await fake.drain()
    expect(log).toEqual(['attempt 1', 'attempt 2', 'attempt 3', 'attempt 4', 'failed: boom 4'])
  })

  it('fail() stops at once; release() retries after its own delay', async () => {
    const Picky = defineJob({
      name: 'picky',
      payload: z.object({ mode: z.enum(['fail', 'release']) }),
      tries: 3,
      handle: ({ mode }, ctx) => (mode === 'fail' ? ctx.fail('not worth retrying') : ctx.attempt === 1 ? ctx.release('5m') : undefined),
      failed: (_p, error) => void log.push(`failed: ${(error as Error).message}`),
    })
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Picky, { mode: 'fail' })
    await queue.dispatch(Picky, { mode: 'release' })
    const results = await fake.drain()
    expect(log).toEqual(['failed: not worth retrying'])
    expect(results.map((r) => r.outcome)).toMatchObject([{ status: 'failed' }, { status: 'retry', delaySeconds: 300 }, { status: 'done' }])
  })

  it('aborts a job that runs past its timeout, and counts it as a failed attempt', async () => {
    let aborted = false
    const Slow = defineJob({
      name: 'slow',
      payload: z.object({}),
      timeout: 0.05,
      handle: (_p, ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => ((aborted = true), resolve()))
        }),
    })
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Slow, {})
    const [result] = await fake.drain()
    expect(aborted).toBe(true)
    expect(result!.outcome).toMatchObject({ status: 'failed', error: { code: 'job_timeout' } })
  })

  it('stops retrying after retryUntil', async () => {
    const Deadline = defineJob({ name: 'deadline', payload: z.object({}), tries: 10, retryUntil: 0, handle: () => Promise.reject(new Error('down')) })
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Deadline, {})
    expect((await fake.drain()).map((r) => r.outcome.status)).toEqual(['failed'])
  })

  it('validates the payload when dispatched, and fails (without retrying) one that no longer fits', async () => {
    const queue = memory()
    const fake = queue.fake()
    // @ts-expect-error wrong payload type
    await expect(queue.dispatch(Greet, { name: 1 })).rejects.toThrow()
    fake.assertNothingDispatched()
    const Changed = defineJob({ name: 'greet', payload: z.object({ name: z.string(), lang: z.string() }), tries: 3, handle: () => {} })
    await queue.dispatch(Greet, { name: 'ann' })
    const worker = memory()
    worker.register(Changed)
    const envelope = fake.dispatched(Greet)[0]!.envelope
    expect(await worker.process(envelope)).toMatchObject({ status: 'failed', error: { code: 'payload_invalid' } })
  })

  it('fails jobs this worker has no code for', async () => {
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Greet, { name: 'x' })
    expect(await memory().process(fake.dispatched()[0]!.envelope)).toMatchObject({ status: 'failed', error: { code: 'job_missing' } })
  })

  it('runs job middleware around the handler', async () => {
    const around: JobMiddleware = async (ctx, next) => {
      log.push(`before ${ctx.job.name}`)
      await next()
      log.push('after')
    }
    const Wrapped = defineJob({ name: 'wrapped', payload: z.object({}), middleware: [around], handle: () => void log.push('handle') })
    const queue = memory()
    const fake = queue.fake()
    await queue.dispatch(Wrapped, {})
    await fake.drain()
    expect(log).toEqual(['before wrapped', 'handle', 'after'])
  })
})

describe('the fake', () => {
  it('asserts on what was dispatched, and only captures the jobs it was given', async () => {
    const queue = createQueue({ default: 'sync', connections: { sync: { driver: 'sync' } } })
    const fake = queue.fake([Greet])
    await queue.dispatch(Greet, { name: 'ann' }, { delay: '5m' })
    await queue.dispatch(Flaky, { failTimes: 0 }) // not faked: runs on the real (sync) driver
    expect(log).toEqual(['attempt 1'])
    fake.assertDispatched(Greet, (p) => p.name === 'ann', 1)
    fake.assertNotDispatched(Greet, (p) => p.name === 'bob')
    expect(fake.dispatched(Greet)[0]!.delaySeconds).toBe(300)
    expect(() => fake.assertDispatched(Flaky)).toThrow(/Expected "flaky" to be dispatched/)
    fake.restore()
    await queue.dispatch(Greet, { name: 'bob' })
    expect(log).toEqual(['attempt 1', 'hi bob'])
  })
})

describe('sync driver', () => {
  it('runs jobs inline, retrying without waiting, and rethrows the final failure', async () => {
    const queue = createQueue({ default: 'sync', connections: { sync: { driver: 'sync' } } })
    await queue.dispatch(Flaky, { failTimes: 1 })
    expect(log).toEqual(['attempt 1', 'attempt 2'])
    log.length = 0
    await expect(queue.dispatch(Flaky, { failTimes: 9 })).rejects.toThrow('boom 4')
    expect(log.at(-1)).toBe('failed: boom 4')
  })
})

describe('chains', () => {
  it('runs jobs in order, and stops at a failure', async () => {
    const Step = defineJob({ name: 'step', payload: z.object({ n: z.number(), fail: z.boolean().default(false) }), handle: ({ n, fail }) => (log.push(`step ${n}`), fail ? Promise.reject(new Error('stop')) : undefined) })
    const queue = memory()
    const fake = queue.fake()
    await queue.chain([Step.with({ n: 1 }), Step.with({ n: 2 }), Step.with({ n: 3 })]).dispatch()
    await fake.drain()
    expect(log).toEqual(['step 1', 'step 2', 'step 3'])
    log.length = 0
    await queue.chain([Step.with({ n: 1 }), Step.with({ n: 2, fail: true }), Step.with({ n: 3 })]).dispatch()
    await fake.drain()
    expect(log).toEqual(['step 1', 'step 2'])
  })
})

describe('unique jobs', () => {
  const Report = defineJob({
    name: 'report',
    payload: z.object({ teamId: z.number() }),
    unique: { key: (p) => String(p.teamId), for: '1h' },
    handle: ({ teamId }) => void log.push(`report ${teamId}`),
  })

  it('queues one per key until it has run', async () => {
    const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } }, { store: () => cache })
    const driver = queue.manager.use('memory') as ReturnType<typeof import('../src/index.js').memoryQueue>
    expect((await queue.dispatch(Report, { teamId: 1 })).dispatched).toBe(true)
    expect((await queue.dispatch(Report, { teamId: 1 })).dispatched).toBe(false)
    expect((await queue.dispatch(Report, { teamId: 2 })).dispatched).toBe(true)
    await driver.drain({ process: (e) => queue.process(e) })
    expect(log).toEqual(['report 1', 'report 2'])
    expect((await queue.dispatch(Report, { teamId: 1 })).dispatched).toBe(true)
  })

  it('needs a lock store', async () => {
    await expect(memory().dispatch(Report, { teamId: 1 })).rejects.toThrow(/Unique jobs need a store/)
  })
})

describe('after commit', () => {
  it('waits for the transaction, and drops the job on rollback', async () => {
    const client = new PGlite()
    const db = createDatabase(drizzle({ client }), { driver: 'postgres' })
    setDefaultDatabase(() => db)
    try {
      const queue = memory()
      const fake = queue.fake()
      await db.transaction(async () => {
        await queue.dispatch(Greet, { name: 'committed' }, { afterCommit: true })
        fake.assertNothingDispatched()
      })
      fake.assertDispatched(Greet, (p) => p.name === 'committed')
      await db
        .transaction(async () => {
          await queue.dispatch(Greet, { name: 'rolled back' }, { afterCommit: true })
          throw new Error('rollback')
        })
        .catch(() => {})
      fake.assertNotDispatched(Greet, (p) => p.name === 'rolled back')
    } finally {
      setDefaultDatabase(undefined)
      await client.close()
    }
  })
})

describe('queueProvider', () => {
  it('makes dispatch() work and gives jobs the app’s services', async () => {
    const UsesCache = defineJob({
      name: 'uses-cache',
      payload: z.object({ key: z.string() }),
      handle: async ({ key }, ctx) => {
        await (ctx.services as unknown as { cache: { put(k: string, v: unknown): Promise<void> } }).cache.put(key, 'from a job')
      },
    })
    const app = createApp({
      env: defineEnv({}),
      providers: [cacheProvider(() => ({ default: 'm', stores: { m: { driver: 'memory' } } })), queueProvider(() => ({ default: 'sync', connections: { sync: { driver: 'sync' } } }))],
    })
    await app.boot({ env: {} })
    await dispatch(UsesCache, { key: 'k' })
    expect(await app.services.cache.get('k')).toBe('from a job')
    await app.shutdown()
  })

  it('gives jobs, and their failed() hook, the app’s config', async () => {
    const seen: unknown[] = []
    const ReadsConfig = defineJob({
      name: 'reads-config',
      payload: z.object({}),
      tries: 1,
      handle: (_payload, ctx) => {
        seen.push((ctx.config as unknown as { app: { url: string } }).app.url)
        throw new Error('done')
      },
      failed: (_payload, _error, { config }) => void seen.push((config as unknown as { app: { url: string } }).app.url),
    })
    const app = createApp({
      env: defineEnv({}),
      config: [defineConfig('app', () => ({ url: 'https://tracker.example' }))],
      providers: [queueProvider(() => ({ default: 'sync', connections: { sync: { driver: 'sync' } } }))],
    })
    await app.boot({ env: {} })
    await dispatch(ReadsConfig, {}).catch(() => {})
    expect(seen).toEqual(['https://tracker.example', 'https://tracker.example'])
    await app.shutdown()
  })
})

describe('a job from another copy of the module (Next.js bundles pages and route handlers separately)', () => {
  it('dispatches it, while registering two different jobs under one name still fails', async () => {
    const queue = memory()
    queue.register(Greet)
    const copy = defineJob({ name: 'greet', payload: z.object({ name: z.string() }), handle: ({ name }) => void log.push(`hi ${name} (copy)`) })
    const fake = queue.fake()
    await queue.dispatch(copy, { name: 'ann' })
    await fake.drain()
    // The registered definition runs: both copies are the same code.
    expect(log).toEqual(['hi ann'])
    expect(() => queue.register(copy)).toThrow('Two different jobs are named "greet".')
  })
})

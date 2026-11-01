import { createCacheService, defineLimiter, perMinute } from '@caldera-js/cache'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueue, defineJob, rateLimited, withoutOverlapping, type Queue } from '../src/index.js'

const log: string[] = []
afterEach(() => {
  log.length = 0
})

const Item = defineJob({
  name: 'batch.item',
  payload: z.object({ n: z.number(), fail: z.boolean().default(false) }),
  handle: ({ n, fail }, ctx) => {
    log.push(`item ${n} of ${ctx.batchId ? 'batch' : 'nothing'}`)
    if (fail) throw new Error(`item ${n} failed`)
  },
})
const Report = defineJob({
  name: 'batch.report',
  payload: z.object({ kind: z.string() }),
  handle: ({ kind }, ctx) => void log.push(`${kind} (${ctx.batchId ? 'knows its batch' : 'no batch'})`),
})

function make() {
  const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
  const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } }, { store: () => cache })
  return { queue, cache, fake: queue.fake() }
}
const items = (...flags: boolean[]) => flags.map((fail, n) => Item.with({ n, fail }))

describe('batches', () => {
  it('runs then and finally once every job succeeded, and reports status', async () => {
    const { queue, fake } = make()
    const { batchId, size } = await queue
      .batch(items(false, false, false), { name: 'import' })
      .then(Report.with({ kind: 'then' }))
      .catch(Report.with({ kind: 'catch' }))
      .finally(Report.with({ kind: 'finally' }))
      .dispatch()
    expect(size).toBe(3)
    expect(await queue.batchStatus(batchId)).toMatchObject({ name: 'import', total: 3, pending: 3, failed: 0, finished: false })
    await fake.drain()
    expect(log).toEqual(['item 0 of batch', 'item 1 of batch', 'item 2 of batch', 'then (knows its batch)', 'finally (knows its batch)'])
    expect(await queue.batchStatus(batchId)).toMatchObject({ pending: 0, failed: 0, finished: true })
  })

  it('on a failure: catch once, the rest skipped, finally, no then', async () => {
    const { queue, fake } = make()
    const { batchId } = await queue.batch(items(false, true, false, true)).then(Report.with({ kind: 'then' })).catch(Report.with({ kind: 'catch' })).finally(Report.with({ kind: 'finally' })).dispatch()
    await fake.drain()
    expect(log).toEqual(['item 0 of batch', 'item 1 of batch', 'catch (knows its batch)', 'finally (knows its batch)'])
    expect(await queue.batchStatus(batchId)).toMatchObject({ pending: 0, failed: 1, finished: true })
  })

  it('with allowFailures, runs everything; catch still runs once', async () => {
    const { queue, fake } = make()
    await queue.batch(items(true, false, true)).allowFailures().then(Report.with({ kind: 'then' })).catch(Report.with({ kind: 'catch' })).finally(Report.with({ kind: 'finally' })).dispatch()
    await fake.drain()
    expect(log.filter((l) => l.startsWith('item'))).toHaveLength(3)
    expect(log.filter((l) => !l.startsWith('item'))).toEqual(['catch (knows its batch)', 'finally (knows its batch)'])
  })

  it('queues nothing when any payload is invalid, and needs a store', async () => {
    const { queue, fake } = make()
    // @ts-expect-error wrong payload
    await expect(queue.batch([Item.with({ n: 'x' })]).dispatch()).rejects.toThrow()
    fake.assertNothingDispatched()
    const bare = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
    await expect(bare.batch(items(false)).dispatch()).rejects.toThrow(/Batches need a store/)
  })

  it('works on the sync driver, inline', async () => {
    const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
    const queue = createQueue({ default: 'sync', connections: { sync: { driver: 'sync' } } }, { store: () => cache })
    await queue.batch(items(false, false)).then(Report.with({ kind: 'then' })).dispatch()
    expect(log).toEqual(['item 0 of batch', 'item 1 of batch', 'then (knows its batch)'])
  })
})

describe('job middleware', () => {
  function withServices(queue: Queue, cache: unknown) {
    queue.services = { cache } as never
    return queue
  }

  it('withoutOverlapping releases a job whose key is busy, and lets it run once free', async () => {
    const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
    const Sync = defineJob({
      name: 'mw.sync',
      payload: z.object({ account: z.string() }),
      tries: 3,
      middleware: [withoutOverlapping<{ account: string }>({ key: (p) => p.account, releaseAfter: '30s' })],
      handle: ({ account }) => void log.push(`sync ${account}`),
    })
    const queue = withServices(createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } }), cache)
    const fake = queue.fake()
    // Someone else holds the lock for account a.
    const held = cache.lock('overlap:mw.sync:a', '1m')
    await held.acquire()
    await queue.dispatch(Sync, { account: 'a' })
    await queue.dispatch(Sync, { account: 'b' })
    // Process each once: a's attempt is released (retry in 30s) while b runs.
    const outcomes = []
    for (const { envelope } of fake.dispatched(Sync)) outcomes.push(await queue.process(envelope))
    expect(log).toEqual(['sync b'])
    expect(outcomes[0]).toMatchObject({ status: 'retry', delaySeconds: 30 })
    await held.release()
  })

  it('rateLimited releases until the limiter has room', async () => {
    const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
    const api = defineLimiter('partner-api', { limits: [perMinute(2)] })
    const Call = defineJob({ name: 'mw.call', payload: z.object({ n: z.number() }), tries: 5, middleware: [rateLimited(api)], handle: ({ n }) => void log.push(`call ${n}`) })
    const queue = withServices(createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } }), cache)
    const fake = queue.fake()
    for (const n of [1, 2, 3]) await queue.dispatch(Call, { n })
    const outcomes: { status: string; delay?: number }[] = []
    for (const { envelope } of fake.dispatched(Call)) {
      const outcome = await queue.process(envelope)
      outcomes.push({ status: outcome.status, ...(outcome.status === 'retry' ? { delay: outcome.delaySeconds } : {}) })
    }
    expect(log).toEqual(['call 1', 'call 2'])
    expect(outcomes[2]).toMatchObject({ status: 'retry' })
    expect(outcomes[2]!.delay).toBeGreaterThanOrEqual(25) // one slot refills every 30s
  })
})

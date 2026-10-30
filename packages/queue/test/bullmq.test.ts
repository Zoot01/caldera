import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueue, defineJob, type Envelope, type Outcome, type Queue, type Worker } from '../src/index.js'
import { hasRedis, startRedis } from './redis-server.js'

let redis: Awaited<ReturnType<typeof startRedis>> | undefined
let queue: Queue
let worker: Worker
const runs: { job: string; attempt: number; at: number; payload: unknown }[] = []
const outcomes: { envelope: Envelope; outcome: Outcome }[] = []
const failed: string[] = []

const Flaky = defineJob({
  name: 'bull.flaky',
  payload: z.object({ id: z.string(), failTimes: z.number() }),
  tries: 3,
  backoff: [0.2, 0.4],
  handle: ({ failTimes }, ctx) => {
    if (ctx.attempt <= failTimes) throw new Error(`boom ${ctx.attempt}`)
  },
  failed: ({ id }) => void failed.push(id),
})
const Final = defineJob({ name: 'bull.final', payload: z.object({ id: z.string() }), tries: 5, handle: (_p, ctx) => ctx.fail('no') })
const Later = defineJob({
  name: 'bull.later',
  payload: z.object({ id: z.string() }),
  tries: 2,
  handle: (_p, ctx) => (ctx.attempt === 1 ? ctx.release(0.3) : undefined),
})
const Step = defineJob({ name: 'bull.step', payload: z.object({ id: z.string() }), queue: 'other', handle: () => {} })

function record(envelope: Envelope, outcome: Outcome) {
  outcomes.push({ envelope, outcome })
  runs.push({ job: envelope.job, attempt: envelope.attempt, at: Date.now(), payload: envelope.payload })
}

async function until<T>(read: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const runsOf = (id: string) => runs.filter((r) => (r.payload as { id: string }).id === id)

describe.runIf(hasRedis)('bullmq driver (real Redis)', () => {
  beforeAll(async () => {
    redis = await startRedis()
    queue = createQueue({ default: 'redis', connections: { redis: { driver: 'bullmq', url: redis.url, prefix: `t${Date.now()}` } } })
    queue.register(Flaky, Final, Later, Step)
    worker = queue.work({ queues: ['default', 'other'], concurrency: 4, onOutcome: record })
  })
  afterAll(async () => {
    await worker?.stop()
    await queue?.manager.purge()
    await redis?.stop()
  })

  it('runs a job, honouring its delay', async () => {
    const sent = Date.now()
    await queue.dispatch(Flaky, { id: 'delayed', failTimes: 0 }, { delay: 0.4 })
    const [run] = await until(() => (runsOf('delayed').length ? runsOf('delayed') : undefined))
    expect(run!.at - sent).toBeGreaterThanOrEqual(350)
  })

  it('retries with the job’s backoff, then calls failed() once', async () => {
    await queue.dispatch(Flaky, { id: 'exhausted', failTimes: 9 })
    await until(() => (failed.includes('exhausted') ? true : undefined))
    const attempts = runsOf('exhausted')
    expect(attempts.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(150) // backoff 0.2s
    expect(attempts[2]!.at - attempts[1]!.at).toBeGreaterThanOrEqual(350) // backoff 0.4s
    await new Promise((r) => setTimeout(r, 500))
    expect(runsOf('exhausted')).toHaveLength(3)
    expect(failed.filter((id) => id === 'exhausted')).toHaveLength(1)
  })

  it('recovers when a retry succeeds', async () => {
    await queue.dispatch(Flaky, { id: 'recovers', failTimes: 1 })
    await until(() => (outcomes.some((o) => (o.envelope.payload as { id: string }).id === 'recovers' && o.outcome.status === 'done') ? true : undefined))
    expect(runsOf('recovers').map((r) => r.attempt)).toEqual([1, 2])
  })

  it('never retries fail(), whatever tries says', async () => {
    await queue.dispatch(Final, { id: 'final' })
    await until(() => (runsOf('final').length ? true : undefined))
    await new Promise((r) => setTimeout(r, 400))
    expect(runsOf('final')).toHaveLength(1)
  })

  it('release() retries after its own delay', async () => {
    await queue.dispatch(Later, { id: 'later' })
    await until(() => (runsOf('later').length === 2 ? true : undefined))
    const [first, second] = runsOf('later')
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(250)
  })

  it('runs a chain across queues', async () => {
    await queue.chain([Step.with({ id: 'c1' }), Flaky.with({ id: 'c2', failTimes: 0 }), Step.with({ id: 'c3' })]).dispatch()
    await until(() => (runsOf('c3').length ? true : undefined))
    expect(runs.filter((r) => ['c1', 'c2', 'c3'].includes((r.payload as { id: string }).id)).map((r) => (r.payload as { id: string }).id)).toEqual(['c1', 'c2', 'c3'])
  })
})

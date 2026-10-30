import { CalderaError, defineDriver } from '@caldera/core'
import { z } from 'zod'
import type { QueueCapabilities, QueueDriver, QueueRuntime, WorkOptions, Worker } from './driver.js'
import type { Envelope } from './envelope.js'
import { backoffFor } from './job.js'

type BullModule = typeof import('bullmq')
type Redis = import('ioredis').default

/**
 * BullMQ over Redis, for long-running Node/Bun workers (`caldera queue:work`). Retries use BullMQ's
 * own attempts, with a backoff strategy that returns exactly the delay processEnvelope decided, so
 * jobs behave the same as on every other driver. Dashboards like Bull Board show them as usual.
 */
export function bullmqQueue(options: { url: string; prefix?: string }): QueueDriver & { close(): Promise<void> } {
  let loaded: Promise<{ bull: BullModule; IORedis: new (url: string, options: object) => Redis }> | undefined
  const load = () =>
    (loaded ??= (async () => {
      // Imported on first use: apps on other drivers don't need bullmq or ioredis.
      const missing = (pkg: string) => () => {
        throw new CalderaError('missing_dependency', `The bullmq queue driver needs ${pkg}: install it in your app.`, { package: pkg })
      }
      const bull = await import('bullmq').catch(missing('bullmq'))
      const ioredis = (await import('ioredis').catch(missing('ioredis'))) as unknown as { default: new (url: string, options: object) => Redis }
      return { bull, IORedis: ioredis.default }
    })())

  const prefix = options.prefix ?? 'caldera'
  const connections: Redis[] = []
  const connect = async () => {
    const { IORedis } = await load()
    // BullMQ requires maxRetriesPerRequest: null (its blocking commands wait indefinitely).
    const connection = new IORedis(options.url, { maxRetriesPerRequest: null })
    connections.push(connection)
    return connection
  }
  const queues = new Map<string, Promise<import('bullmq').Queue>>()
  const queue = (name: string) => {
    let existing = queues.get(name)
    if (!existing) {
      existing = (async () => new (await load()).bull.Queue(name, { connection: await connect(), prefix }))()
      queues.set(name, existing)
    }
    return existing
  }
  const workers: import('bullmq').Worker[] = []

  return {
    async push(envelope, delaySeconds) {
      await (await queue(envelope.queue)).add(envelope.job, envelope, {
        jobId: envelope.id,
        delay: Math.round(delaySeconds * 1000),
        attempts: envelope.maxTries - envelope.attempt + 1,
        backoff: { type: 'caldera' },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      })
    },

    work(workOptions: WorkOptions, runtime: QueueRuntime): Worker {
      const starting = (async () => {
        const { bull } = await load()
        // The delay processEnvelope chose for each job's next retry (release() can override backoff).
        const nextDelay = new Map<string, number>()
        for (const name of workOptions.queues) {
          const worker = new bull.Worker<Envelope>(
            name,
            async (job) => {
              const envelope: Envelope = { ...job.data, attempt: job.data.attempt + job.attemptsMade }
              const outcome = await runtime.process(envelope)
              workOptions.onOutcome?.(envelope, outcome)
              if (outcome.status === 'done') return
              const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
              if (outcome.status === 'failed') throw new bull.UnrecoverableError(message)
              nextDelay.set(job.id!, outcome.delaySeconds)
              throw outcome.error instanceof Error ? outcome.error : new Error(message)
            },
            {
              connection: await connect(),
              prefix,
              concurrency: workOptions.concurrency,
              settings: {
                backoffStrategy: (attemptsMade, _type, _error, job) => {
                  const id = job?.id ?? ''
                  const seconds = nextDelay.get(id) ?? backoffFor((job?.data as Envelope | undefined)?.backoff ?? [0], attemptsMade)
                  nextDelay.delete(id)
                  return Math.round(seconds * 1000)
                },
              },
            },
          )
          worker.on('error', (error) => console.error('[caldera] queue worker error', error))
          workers.push(worker)
        }
      })()
      return {
        async stop() {
          await starting
          await Promise.all(workers.splice(0).map((w) => w.close()))
        },
      }
    },

    async close() {
      await Promise.all(workers.splice(0).map((w) => w.close()))
      await Promise.all([...queues.values()].map(async (q) => (await q).close()))
      queues.clear()
      await Promise.all(connections.splice(0).map((c) => c.quit().catch(() => {})))
    },
  }
}

export const bullmqDriver = defineDriver<QueueDriver, QueueCapabilities, { url: string; prefix?: string }>({
  name: 'bullmq',
  schema: z.object({ url: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'), prefix: z.string().optional() }),
  capabilities: { delay: true, maxDelaySeconds: null, maxPayloadBytes: null, workers: true, durable: true },
  create: (config) => bullmqQueue(config),
  close: (driver) => (driver as ReturnType<typeof bullmqQueue>).close(),
})

import { CalderaError, defineDriver } from '@caldera/core'
import { z } from 'zod'
import type { QueueCapabilities, QueueDriver } from './driver.js'
import type { Envelope } from './envelope.js'
import type { AnyJob } from './job.js'
import type { Queue } from './queue.js'

/** A Cloudflare Queues producer binding (`env.JOBS` from `[[queues.producers]]` in wrangler.toml). */
export interface QueueBinding {
  send(body: unknown, options?: { delaySeconds?: number; contentType?: 'json' }): Promise<unknown>
}

/** What Cloudflare hands a consumer's `queue()` handler. */
export interface MessageBatchLike {
  readonly queue: string
  readonly messages: readonly {
    readonly id: string
    readonly body: unknown
    readonly attempts: number
    ack(): void
    retry(options?: { delaySeconds?: number }): void
  }[]
}

const isBinding = (value: unknown): value is QueueBinding => typeof (value as QueueBinding | undefined)?.send === 'function'

/**
 * Cloudflare Queues. Each Caldera queue name maps to a producer binding; `default` is required:
 * `{ driver: 'cloudflare', queues: { default: env.JOBS, mail: env.MAIL } }`. Limits from Cloudflare:
 * delays up to 24h, messages up to 128KB (pass ids, not data).
 */
export const cloudflareDriver = defineDriver<QueueDriver, QueueCapabilities, { queues: Record<string, QueueBinding> }>({
  name: 'cloudflare',
  schema: z.object({
    queues: z
      .record(z.string(), z.custom<QueueBinding>(isBinding, 'must be a Cloudflare Queues producer binding (env.MY_QUEUE)'))
      .refine((q) => 'default' in q, 'needs a `default` queue'),
  }),
  capabilities: { delay: true, maxDelaySeconds: 86_400, maxPayloadBytes: 128_000, workers: false, durable: true },
  create: (config) => ({
    async push(envelope, delaySeconds) {
      const binding = config.queues[envelope.queue] ?? config.queues.default!
      await binding.send(envelope, { contentType: 'json', ...(delaySeconds > 0 ? { delaySeconds: Math.ceil(delaySeconds) } : {}) })
    },
  }),
})

interface BootableApp {
  boot(options?: { env?: Record<string, unknown> }): Promise<unknown>
  readonly services: unknown
}

/**
 * The consumer: `export default { fetch: http.fetch, queue: (batch, env, ctx) => handleQueueBatch(app, batch, env, { jobs }) }`
 * with `jobs` from `.caldera/jobs.gen.ts`. Each message runs through the same rules as every driver.
 * A retry is sent as a new message (attempt + 1, with the job's backoff) and the old one acked, so the
 * job's `tries` decide, not the queue's `max_retries`. If that send fails, Cloudflare redelivers.
 */
export async function handleQueueBatch(
  app: BootableApp,
  batch: MessageBatchLike,
  env: Record<string, unknown>,
  options: { jobs: readonly AnyJob[]; connection?: string },
): Promise<void> {
  await app.boot({ env })
  const queue = (app.services as { queue?: Queue }).queue
  if (!queue) throw new CalderaError('queue_not_configured', 'handleQueueBatch needs queueProvider() in the app.')
  queue.register(...options.jobs)
  await Promise.all(
    batch.messages.map(async (message) => {
      const envelope = message.body as Envelope
      if (envelope?.v !== 1) {
        console.error(`[caldera] dropping a message that isn't a Caldera job (id ${message.id})`)
        return message.ack()
      }
      try {
        const outcome = await queue.process(envelope)
        if (outcome.status === 'retry') {
          await queue.manager.use(options.connection ?? queue.manager.defaultName).push({ ...envelope, attempt: envelope.attempt + 1 }, outcome.delaySeconds, { process: queue.process })
        }
        message.ack()
      } catch (error) {
        console.error(`[caldera] queue message ${message.id} could not be handled; Cloudflare will redeliver it`, error)
        message.retry()
      }
    }),
  )
}

import { CalderaError, defineDriver } from '@caldera/core'
import { Client, Receiver } from '@upstash/qstash'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { QueueCapabilities, QueueDriver } from './driver.js'
import type { Envelope } from './envelope.js'
import type { AnyJob } from './job.js'
import type { Queue } from './queue.js'

const configSchema = z.object({
  token: z.string().min(1),
  /** Your app's public URL for the receiver route, e.g. `https://app.example.com/_caldera/queue`. */
  url: z.url(),
  /** QStash's API (the local dev server, or a region). Default: Upstash's. */
  baseUrl: z.url().optional(),
  currentSigningKey: z.string().min(1),
  nextSigningKey: z.string().min(1),
  /** How often QStash redelivers when your endpoint is down (job retries are separate). Default 3. */
  deliveryRetries: z.number().int().min(0).default(3),
})
type QstashConfig = z.infer<typeof configSchema>

export interface QstashQueue extends QueueDriver {
  /** Checks a delivery's `Upstash-Signature` (signed for the configured `url`). */
  verify(signature: string, body: string): Promise<boolean>
}

/**
 * QStash (Upstash): queueing over signed HTTP, for serverless apps with no workers (Vercel, Netlify,
 * any Node or edge host). QStash POSTs each job to `qstashReceiver()`. Job retries are published again
 * by Caldera with the job's backoff, so the job's rules decide; QStash's own retries only cover your
 * endpoint being unreachable.
 */
export function qstashQueue(config: QstashConfig): QstashQueue {
  const client = new Client({ token: config.token, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) })
  const receiver = new Receiver({ currentSigningKey: config.currentSigningKey, nextSigningKey: config.nextSigningKey })
  return {
    async push(envelope, delaySeconds) {
      await client.publishJSON({
        url: config.url,
        body: envelope,
        retries: config.deliveryRetries,
        ...(delaySeconds > 0 ? { delay: Math.ceil(delaySeconds) } : {}),
      })
    },
    async verify(signature, body) {
      try {
        return await receiver.verify({ signature, body, url: config.url })
      } catch {
        return false
      }
    },
  }
}

export const qstashDriver = defineDriver<QueueDriver, QueueCapabilities, QstashConfig>({
  name: 'qstash',
  schema: configSchema,
  capabilities: { delay: true, maxDelaySeconds: null, maxPayloadBytes: null, workers: false, durable: true },
  create: (config) => qstashQueue(config),
})

/**
 * The route QStash delivers to: `http.route('/', qstashReceiver({ jobs }))` with `jobs` from
 * `.caldera/jobs.gen.ts`. Unsigned or tampered requests get 401. Every processed outcome answers 200
 * (a retry is already published again); only an unexpected crash answers 500, so QStash redelivers.
 */
export function qstashReceiver(options: { jobs: readonly AnyJob[]; path?: string; connection?: string }): Hono {
  const path = options.path ?? '/_caldera/queue'
  let registered = false
  return new Hono().post(path, async (c: Context) => {
    const queue = (c.var as { queue?: Queue }).queue
    if (!queue) throw new CalderaError('queue_not_configured', 'qstashReceiver needs queueProvider() in the app.')
    const connection = options.connection ?? queue.manager.defaultName
    const driver = queue.manager.use(connection) as QstashQueue
    if (typeof driver.verify !== 'function') throw new CalderaError('queue_not_qstash', `queue.${connection} isn't a qstash connection.`)

    const body = await c.req.text()
    const signature = c.req.header('upstash-signature')
    if (!signature || !(await driver.verify(signature, body))) return c.json({ error: { code: 'invalid_signature', message: 'Not a valid QStash delivery.' } }, 401)

    if (!registered) {
      queue.register(...options.jobs)
      registered = true
    }
    const envelope = JSON.parse(body) as Envelope
    if (envelope?.v !== 1) return c.json({ status: 'ignored' }, 200)
    const outcome = await queue.process(envelope)
    if (outcome.status === 'retry') await driver.push({ ...envelope, attempt: envelope.attempt + 1 }, outcome.delaySeconds, { process: queue.process })
    return c.json({ status: outcome.status }, 200)
  })
}

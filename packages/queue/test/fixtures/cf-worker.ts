// A Cloudflare Worker using Caldera queues, bundled by the test with esbuild (as wrangler would).
import { createApp, defineConfig, defineEnv } from '@caldera-js/core'
import { defineJob, dispatch, handleQueueBatch, queueProvider, type MessageBatchLike, type QueueBinding } from '@caldera-js/queue'
import { Hono } from 'hono'
import { z } from 'zod'

interface Kv {
  put(key: string, value: string): Promise<void>
}
let results: Kv

const Record = defineJob({
  name: 'cf.record',
  payload: z.object({ id: z.string() }),
  handle: async ({ id }, ctx) => results.put(`done:${id}`, String(ctx.attempt)),
})
const Flaky = defineJob({
  name: 'cf.flaky',
  payload: z.object({ id: z.string() }),
  tries: 3,
  backoff: 1,
  handle: async ({ id }, ctx) => {
    await results.put(`attempt:${id}:${ctx.attempt}`, String(Date.now()))
    if (ctx.attempt < 3) throw new Error(`attempt ${ctx.attempt} fails`)
    await results.put(`done:${id}`, String(ctx.attempt))
  },
})
const jobs = [Record, Flaky]

const env = defineEnv({ JOBS: z.custom<QueueBinding>((v) => typeof (v as QueueBinding)?.send === 'function') })
// This fixture has no generated Register, so the env is typed by hand.
const queueConfig = defineConfig('queue', (e) => ({
  default: 'cf' as const,
  connections: { cf: { driver: 'cloudflare', queues: { default: (e as unknown as { JOBS: QueueBinding }).JOBS } } },
}))
const app = createApp({ env, config: [queueConfig], providers: [queueProvider((a) => (a.config as unknown as { queue: never }).queue)] })

const http = new Hono().use(app.middleware()).post('/dispatch/:job/:id', async (c) => {
  const job = c.req.param('job') === 'flaky' ? Flaky : Record
  await dispatch(job, { id: c.req.param('id') })
  return c.text('queued')
})

export default {
  fetch(request: Request, bindings: { RESULTS: Kv }, ctx: unknown) {
    results = bindings.RESULTS
    return http.fetch(request, bindings, ctx as never)
  },
  async queue(batch: MessageBatchLike, bindings: { RESULTS: Kv } & Record<string, unknown>) {
    results = bindings.RESULTS
    await handleQueueBatch(app, batch, bindings, { jobs })
  },
}

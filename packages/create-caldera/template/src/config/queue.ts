import { defineConfig } from '@caldera/core'

export const queue = defineConfig('queue', (env) => ({
  // sync runs a job as soon as it's dispatched (development, tests); deferred runs it right after the
  // response; database (the production default: durable, nothing else to run) and redis (BullMQ)
  // queue it for `pnpm worker`.
  default: env.QUEUE_CONNECTION,
  connections: {
    sync: { driver: 'sync' },
    deferred: { driver: 'deferred' },
    database: { driver: 'database' },
    ...(env.REDIS_URL ? { redis: { driver: 'bullmq', url: env.REDIS_URL } } : {}),
    // Cloudflare Queues on Workers (the QUEUE binding); src/worker.ts consumes them.
    ...(env.QUEUE ? { cloudflare: { driver: 'cloudflare', queues: { default: env.QUEUE } } } : {}),
  },
}))

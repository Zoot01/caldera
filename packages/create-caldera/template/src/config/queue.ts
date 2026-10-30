import { defineConfig } from '@caldera/core'

export const queue = defineConfig('queue', (env) => ({
  // sync runs a job as soon as it's dispatched (development, tests); deferred runs it right after the
  // response; redis queues it in BullMQ for `pnpm worker`.
  default: env.QUEUE_CONNECTION,
  connections: {
    sync: { driver: 'sync' },
    deferred: { driver: 'deferred' },
    ...(env.REDIS_URL ? { redis: { driver: 'bullmq', url: env.REDIS_URL } } : {}),
  },
}))

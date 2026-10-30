import { defineConfig } from '@caldera/core'

export const cache = defineConfig('cache', (env) => ({
  // Memory works on one server; with REDIS_URL set, the cache (and so unique jobs, batches and rate
  // limits) is shared by every server and worker.
  default: env.REDIS_URL ? ('redis' as const) : ('memory' as const),
  stores: {
    memory: { driver: 'memory' },
    ...(env.REDIS_URL ? { redis: { driver: 'redis', url: env.REDIS_URL } } : {}),
  },
}))

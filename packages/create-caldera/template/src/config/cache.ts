import { defineConfig } from '@caldera/core'

export const cache = defineConfig('cache', (env) => ({
  // Memory works on one server; with REDIS_URL set, the cache (and so unique jobs, batches and rate
  // limits) is shared by every server and worker. On Workers (a D1 binding) it's the database store.
  default: env.REDIS_URL ? ('redis' as const) : env.DB ? ('database' as const) : ('memory' as const),
  stores: {
    memory: { driver: 'memory' },
    // Rows in caldera_cache (src/db/tables/caldera-cache.ts): shared, on any SQL database, D1 too.
    database: { driver: 'database' },
    ...(env.REDIS_URL ? { redis: { driver: 'redis', url: env.REDIS_URL } } : {}),
  },
}))

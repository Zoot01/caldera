import { defineConfig } from '@caldera-js/core'

export const queue = defineConfig('queue', (env) => ({
  default: 'redis' as const,
  connections: { redis: { driver: 'bullmq', url: env.REDIS_URL } },
}))

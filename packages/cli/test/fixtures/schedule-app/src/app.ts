import { cacheProvider } from '@caldera/cache'
import { createApp } from '@caldera/core'
import { queueProvider } from '@caldera/queue'
import { scheduleProvider } from '@caldera/schedule'
import { config } from '../.caldera/config.gen.js'
import { schedules } from '../.caldera/schedules.gen.js'
import { env } from './env.js'

export const app = createApp({
  env,
  config,
  providers: [
    cacheProvider(() => ({ default: 'memory', stores: { memory: { driver: 'memory' } } })),
    queueProvider(() => ({ default: 'sync', connections: { sync: { driver: 'sync' } } })),
    scheduleProvider({ schedules }),
  ],
})

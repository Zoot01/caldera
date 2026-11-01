import { cacheProvider } from '@caldera-js/cache'
import { createApp } from '@caldera-js/core'
import { queueProvider } from '@caldera-js/queue'
import { scheduleProvider } from '@caldera-js/schedule'
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

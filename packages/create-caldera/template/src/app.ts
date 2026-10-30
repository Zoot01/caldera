import { cacheProvider } from '@caldera/cache'
import { redisDriver } from '@caldera/cache/redis'
import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { sessionProvider } from '@caldera/http'
import { queueProvider } from '@caldera/queue'
import { bullmqDriver } from '@caldera/queue/bullmq'
import { drizzle } from 'drizzle-orm/libsql'
import { config } from '../.caldera/config.gen.js'
import { relations } from './db/relations.js'
import { env } from './env.js'

export const app = createApp({
  env,
  config,
  providers: [
    databaseProvider({
      driver: 'sqlite',
      connect: (app) => drizzle({ connection: { url: app.config.database.url }, relations }),
    }),
    sessionProvider((app) => app.config.session),
    cacheProvider((app) => app.config.cache, { drivers: [redisDriver] }),
    // Unique jobs and batches keep their state in the cache above.
    queueProvider((app) => app.config.queue, { drivers: [bullmqDriver] }),
  ],
})

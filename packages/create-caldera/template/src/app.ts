import { cacheProvider } from '@caldera/cache'
import { redisDriver } from '@caldera/cache/redis'
import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { eventsProvider } from '@caldera/events'
import { sessionProvider } from '@caldera/http'
import { queueProvider } from '@caldera/queue'
import { bullmqDriver } from '@caldera/queue/bullmq'
import { databaseDriver } from '@caldera/queue/database'
import { scheduleProvider } from '@caldera/schedule'
import { drizzle } from 'drizzle-orm/libsql'
import { config } from '../.caldera/config.gen.js'
import { listeners } from '../.caldera/listeners.gen.js'
import { schedules } from '../.caldera/schedules.gen.js'
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
    queueProvider((app) => app.config.queue, { drivers: [databaseDriver, bullmqDriver] }),
    // Every listener in src/listeners, registered by `caldera generate`.
    eventsProvider({ listeners }),
    // Every schedule in src/schedules. `pnpm scheduler` runs them locally; see AGENTS.md for platforms.
    scheduleProvider({ schedules }),
  ],
})

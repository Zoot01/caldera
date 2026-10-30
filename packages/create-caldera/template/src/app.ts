import { cacheProvider } from '@caldera/cache'
import { redisDriver } from '@caldera/cache/redis'
import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { eventsProvider } from '@caldera/events'
import { mailProvider } from '@caldera/mail'
import { sesDriver } from '@caldera/mail/ses'
import { smtpDriver } from '@caldera/mail/smtp'
import { sessionProvider } from '@caldera/http'
import { queueProvider } from '@caldera/queue'
import { bullmqDriver } from '@caldera/queue/bullmq'
import { databaseDriver } from '@caldera/queue/database'
import { scheduleProvider } from '@caldera/schedule'
import { storageProvider } from '@caldera/storage'
import { localStorageDriver } from '@caldera/storage/local'
import { s3StorageDriver } from '@caldera/storage/s3'
import { drizzle } from 'drizzle-orm/libsql'
import { config } from '../.caldera/config.gen.js'
import { listeners } from '../.caldera/listeners.gen.js'
import { mails } from '../.caldera/mails.gen.js'
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
    // Disks in src/config/storage.ts: c.var.storage, storage.disk('public').
    storageProvider((app) => app.config.storage, { drivers: [localStorageDriver, s3StorageDriver] }),
    // Mailers in src/config/mail.ts; every mail in src/mail. c.var.mail, or `mail` from '@caldera/mail'.
    mailProvider((app) => app.config.mail, { mails, drivers: [sesDriver, smtpDriver] }),
  ],
})

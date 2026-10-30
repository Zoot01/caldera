import { AsyncLocalStorage } from 'node:async_hooks'
import { broadcastProvider } from '@caldera/broadcast'
import { durableObjectDriver } from '@caldera/broadcast/cloudflare'
import { cacheProvider } from '@caldera/cache'
import { databaseCacheDriver } from '@caldera/cache/database'
import { redisDriver } from '@caldera/cache/redis'
import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { eventsProvider } from '@caldera/events'
import { i18nProvider } from '@caldera/i18n'
import { mailProvider } from '@caldera/mail'
import { sesDriver } from '@caldera/mail/ses'
import { smtpDriver } from '@caldera/mail/smtp'
import { sessionProvider } from '@caldera/http'
import { notificationsProvider } from '@caldera/notifications'
import { databaseChannel } from '@caldera/notifications/database'
import { queueProvider } from '@caldera/queue'
import { bullmqDriver } from '@caldera/queue/bullmq'
import { databaseDriver } from '@caldera/queue/database'
import { scheduleProvider } from '@caldera/schedule'
import { storageProvider } from '@caldera/storage'
import { localStorageDriver } from '@caldera/storage/local'
import { s3StorageDriver } from '@caldera/storage/s3'
import { drizzle as d1 } from 'drizzle-orm/d1'
import { drizzle } from 'drizzle-orm/libsql'
import { channels } from '../.caldera/channels.gen.js'
import { config } from '../.caldera/config.gen.js'
import { messages, pages } from '../.caldera/i18n.gen.js'
import { listeners } from '../.caldera/listeners.gen.js'
import { mails } from '../.caldera/mails.gen.js'
import { notifications } from '../.caldera/notifications.gen.js'
import { schedules } from '../.caldera/schedules.gen.js'
import { relations } from './db/relations.js'
import { UserNotifiable } from './models/user.js'
import { env } from './env.js'

export const app = createApp({
  env,
  config,
  // app.current(): the request being handled, wherever code runs. The deferred queue uses it to find
  // the platform's waitUntil (Vercel, Workers), so queued work finishes after the response.
  asyncContext: AsyncLocalStorage,
  providers: [
    // libSQL (DATABASE_URL), or D1 on Cloudflare Workers (the DB binding).
    databaseProvider({
      driver: (app) => (app.env.DB ? 'd1' : 'sqlite'),
      connect: (app) => (app.env.DB ? d1(app.env.DB as never, { relations }) : drizzle({ connection: { url: app.config.database.url, authToken: app.config.database.authToken }, relations })),
    }),
    sessionProvider((app) => app.config.session),
    // Messages from lang/; c.var.i18n is this request's translator (user, cookie, Accept-Language).
    i18nProvider((app) => app.config.i18n, { messages, pages }),
    cacheProvider((app) => app.config.cache, { drivers: [databaseCacheDriver, redisDriver] }),
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
    // Every notification in src/notifications. `notify(user, Welcome, payload)`; `inbox(user)` reads
    // the database channel (the caldera_notifications table).
    notificationsProvider({ notifications, notifiable: UserNotifiable, channels: [databaseChannel()] }),
    // Realtime: every channel in src/channels; events with \`broadcast\` reach browsers on them.
    broadcastProvider((app) => app.config.broadcast, { channels, drivers: [durableObjectDriver] }),
  ],
})

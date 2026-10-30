import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { mailProvider } from '@caldera/mail'
import { drizzle } from 'drizzle-orm/libsql'
import { config } from '../.caldera/config.gen.js'
import { mails } from '../.caldera/mails.gen.js'
import { env } from './env.js'

export const app = createApp({
  env,
  config,
  providers: [
    databaseProvider({ driver: 'sqlite', connect: (app) => drizzle({ connection: { url: app.env.DATABASE_URL } }) }),
    mailProvider((app) => app.config.mail, { mails }),
  ],
})

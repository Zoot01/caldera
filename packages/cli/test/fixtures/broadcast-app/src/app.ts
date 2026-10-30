import { broadcastProvider } from '@caldera/broadcast'
import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { drizzle } from 'drizzle-orm/libsql'
import { channels } from '../.caldera/channels.gen.js'
import { config } from '../.caldera/config.gen.js'
import { relations } from './db/relations.js'
import { env } from './env.js'

export const app = createApp({
  env,
  config,
  providers: [
    databaseProvider({ driver: 'sqlite', connect: (app) => drizzle({ connection: { url: app.env.DATABASE_URL }, relations }) }),
    broadcastProvider((app) => app.config.broadcast, { channels }),
  ],
})

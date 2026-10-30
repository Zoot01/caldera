import { PGlite } from '@electric-sql/pglite'
import { createApp } from '@caldera/core'
import { databaseProvider } from '@caldera/db'
import { drizzle } from 'drizzle-orm/pglite'
import { relations } from './db/relations.js'
import { env } from './env.js'

// An in-memory Postgres per process: each `caldera db:seed` run starts empty.
export const app = createApp({
  env,
  providers: [databaseProvider({ driver: 'postgres', connect: () => drizzle({ client: new PGlite(), relations }) })],
})

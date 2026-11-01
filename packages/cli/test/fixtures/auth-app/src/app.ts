import { PGlite } from '@electric-sql/pglite'
import { betterAuthProvider } from '@caldera-js/auth'
import { createApp } from '@caldera-js/core'
import { databaseProvider } from '@caldera-js/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, organization } from 'better-auth/plugins'
import { defineRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { users } from './db/schema.js'
import { env } from './env.js'

export const app = createApp({
  env,
  providers: [
    databaseProvider({ driver: 'postgres', connect: () => drizzle({ client: new PGlite(), relations: defineRelations({ users }) }) }),
    betterAuthProvider({
      create: ({ db }) =>
        betterAuth({
          secret: 'fixture-secret-0123456789-abcdefghijkl',
          logger: { disabled: true },
          database: drizzleAdapter(db as never, { provider: 'pg', schema: { users } }),
          user: { modelName: 'users' },
          advanced: { database: { generateId: 'uuid' } },
          plugins: [organization(), admin()],
        }),
    }),
  ],
})

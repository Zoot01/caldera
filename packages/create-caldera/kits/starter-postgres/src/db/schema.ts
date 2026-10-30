import { authUserColumns } from '@caldera/auth'
import { snakeCase } from 'drizzle-orm/pg-core'
import { authSchema } from './auth-schema.js'

// The app owns the users table; Better Auth signs people in against it (src/auth.ts). Add your own
// columns here.
export const users = snakeCase.table('users', {
  ...authUserColumns(),
})

// Better Auth's sessions, accounts and tokens (src/db/auth-schema.ts, from `caldera auth:schema`).
export const { session, account, verification } = authSchema(users)

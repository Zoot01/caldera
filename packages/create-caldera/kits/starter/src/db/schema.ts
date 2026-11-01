import { authUserColumns } from '@caldera-js/auth/sqlite'
import { integer, snakeCase } from 'drizzle-orm/sqlite-core'
import { authSchema } from './auth-schema.js'

// The app owns the users table; Better Auth signs people in against it (src/auth.ts). Add your own
// columns here.
export const users = snakeCase.table('users', {
  ...authUserColumns(),
  // Set by Better Auth's two-factor plugin once the person confirms their authenticator app.
  twoFactorEnabled: integer({ mode: 'boolean' }).notNull().default(false),
})

// Better Auth's sessions, accounts, tokens, second factors and passkeys (src/db/auth-schema.ts, from
// `caldera auth:schema`). Better Auth uses this file's exports as its tables (src/auth.ts).
export const { session, account, verification, twoFactor, passkey } = authSchema(users)

import { boolean, snakeCase, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

const at = () => timestamp({ withTimezone: true })
const createdAt = () => at().notNull().defaultNow()
const updatedAt = () =>
  at()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/**
 * The columns Better Auth requires on the app-owned users table (Postgres). Spread them in and
 * add your own: `snakeCase.table('users', { ...authUserColumns(), plan: text() })`. Pair with
 * `advanced.database.generateId: 'uuid'` so Better Auth's ids match the `uuid` column.
 */
export function authUserColumns() {
  return {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }
}

/**
 * Better Auth's own tables (session, account, verification) for Postgres, referencing the app's
 * users table. Plugins (organizations, 2FA…) add more: generate those with Better Auth's CLI.
 */
export function authTables(users: { id: AnyPgColumn }) {
  const userId = () =>
    uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
  return {
    session: snakeCase.table('session', {
      id: uuid().primaryKey().defaultRandom(),
      expiresAt: at().notNull(),
      token: text().notNull().unique(),
      ipAddress: text(),
      userAgent: text(),
      userId: userId(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    }),
    account: snakeCase.table('account', {
      id: uuid().primaryKey().defaultRandom(),
      accountId: text().notNull(),
      providerId: text().notNull(),
      userId: userId(),
      accessToken: text(),
      refreshToken: text(),
      idToken: text(),
      accessTokenExpiresAt: at(),
      refreshTokenExpiresAt: at(),
      scope: text(),
      password: text(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    }),
    verification: snakeCase.table('verification', {
      id: uuid().primaryKey().defaultRandom(),
      identifier: text().notNull(),
      value: text().notNull(),
      expiresAt: at().notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    }),
  }
}

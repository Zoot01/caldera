import { integer, snakeCase, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

const at = () => integer({ mode: 'timestamp_ms' })
const createdAt = () =>
  at()
    .notNull()
    .$defaultFn(() => new Date())
const updatedAt = () =>
  at()
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date())
const id = () =>
  text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

/** The columns Better Auth requires on the app-owned users table (SQLite). See the Postgres version for usage. */
export function authUserColumns() {
  return {
    id: id(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: integer({ mode: 'boolean' }).notNull().default(false),
    image: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }
}

/** Better Auth's session, account and verification tables for SQLite, referencing the app's users table. */
export function authTables(users: { id: AnySQLiteColumn }) {
  const userId = () =>
    text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
  return {
    session: snakeCase.table('session', {
      id: id(),
      expiresAt: at().notNull(),
      token: text().notNull().unique(),
      ipAddress: text(),
      userAgent: text(),
      userId: userId(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    }),
    account: snakeCase.table('account', {
      id: id(),
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
      id: id(),
      identifier: text().notNull(),
      value: text().notNull(),
      expiresAt: at().notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    }),
  }
}

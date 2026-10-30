import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The `database` cache store (@caldera/cache/database): one row per key, plus rate-limit counters.
 * Caldera reads and writes it; no model needed. Works on SQLite, libSQL and D1.
 */
export const calderaCache = sqliteTable('caldera_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at'),
})

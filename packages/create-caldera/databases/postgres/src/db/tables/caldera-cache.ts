import { bigint, pgTable, text } from 'drizzle-orm/pg-core'

/**
 * The `database` cache store (@caldera-js/cache/database): one row per key, plus rate-limit counters.
 * Caldera reads and writes it; no model needed.
 */
export const calderaCache = pgTable('caldera_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
})

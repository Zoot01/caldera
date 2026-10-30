import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Jobs for the `database` queue driver: written on dispatch, claimed by `caldera queue:work`, kept here
 * when they fail (`caldera queue:failed`). Caldera reads and writes it; no model needed.
 */
export const calderaJobs = sqliteTable(
  'caldera_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    envelope: text('envelope').notNull(),
    attempts: integer('attempts').notNull().default(0),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    availableAt: integer('available_at').notNull(),
    reservedUntil: integer('reserved_until'),
    reservedBy: text('reserved_by'),
    failedAt: integer('failed_at'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('caldera_jobs_queue_available').on(t.queue, t.availableAt)],
)

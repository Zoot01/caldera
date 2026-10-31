import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core'

/**
 * Jobs for the `database` queue driver: written on dispatch, claimed by `caldera queue:work`, kept here
 * when they fail (`caldera queue:failed`). Caldera reads and writes it; no model needed.
 */
export const calderaJobs = pgTable(
  'caldera_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    envelope: text('envelope').notNull(),
    attempts: integer('attempts').notNull().default(0),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    availableAt: bigint('available_at', { mode: 'number' }).notNull(),
    reservedUntil: bigint('reserved_until', { mode: 'number' }),
    reservedBy: text('reserved_by'),
    failedAt: bigint('failed_at', { mode: 'number' }),
    error: text('error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('caldera_jobs_queue_available').on(t.queue, t.availableAt)],
)

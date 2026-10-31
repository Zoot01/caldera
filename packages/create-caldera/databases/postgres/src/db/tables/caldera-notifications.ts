import { bigint, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Notifications for the `database` channel (@caldera/notifications/database): one row per send, read
 * back with `inbox(user)`. Caldera reads and writes it; no model needed.
 */
export const calderaNotifications = pgTable(
  'caldera_notifications',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    notifiableType: text('notifiable_type').notNull(),
    notifiableId: text('notifiable_id').notNull(),
    data: jsonb('data').notNull(),
    readAt: bigint('read_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('caldera_notifications_notifiable').on(t.notifiableType, t.notifiableId, t.createdAt),
    index('caldera_notifications_unread').on(t.notifiableType, t.notifiableId).where(sql`${t.readAt} is null`),
  ],
)

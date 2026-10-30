import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Notifications for the `database` channel (@caldera/notifications/database): one row per send, read
 * back with `inbox(user)`. `data` is JSON text. Caldera reads and writes it; no model needed.
 */
export const calderaNotifications = sqliteTable(
  'caldera_notifications',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    notifiableType: text('notifiable_type').notNull(),
    notifiableId: text('notifiable_id').notNull(),
    data: text('data').notNull(),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('caldera_notifications_notifiable').on(t.notifiableType, t.notifiableId, t.createdAt),
    index('caldera_notifications_unread').on(t.notifiableType, t.notifiableId).where(sql`${t.readAt} is null`),
  ],
)

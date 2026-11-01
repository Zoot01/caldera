import { CalderaError, CapabilityError } from '@caldera-js/core'
import { defaultDatabase, type Database } from '@caldera-js/db'
import { sql, type SQL } from 'drizzle-orm'
import type { Notifiable } from './notification.js'
import type { DatabaseChannel, Inbox, StoredNotification } from './service.js'

interface Row {
  id: string
  type: string
  data: unknown
  read_at: number | string | null
  created_at: number | string
}

/**
 * The `database` channel: notifications stored in your own database (the `caldera_notifications`
 * table, from `caldera notifications:table`), for an in-app inbox. Postgres keeps `data` as jsonb,
 * SQLite as JSON text. Writes go through the current transaction, so a notification sent inside one
 * exists only once it commits. A retried job doesn't store it twice: the row's id is the send's id.
 */
export function databaseChannel(options: { table?: string; database?: () => Database<any> } = {}): DatabaseChannel {
  const name = options.table ?? 'caldera_notifications'
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new CalderaError('table_name_invalid', `Notifications table "${name}" must be a plain lowercase table name.`)
  const table = sql.identifier(name)
  const resolve = options.database ?? defaultDatabase

  const dialectOf = (db: Database<any>): 'pg' | 'sqlite' => {
    if (db.driver === 'postgres') return 'pg'
    if (db.driver === 'sqlite' || db.driver === 'sqlite-sync' || db.driver === 'd1') return 'sqlite'
    throw new CapabilityError(`database (${db.driver})`, 'the database notification channel', 'It needs Postgres, SQLite, libSQL or D1.')
  }
  const run = async <T>(query: SQL): Promise<T[]> => {
    const db = resolve()
    const target = db.current() as { execute?(q: SQL): Promise<unknown>; all?(q: SQL): unknown }
    if (dialectOf(db) === 'pg') {
      const result = (await target.execute!(query)) as { rows?: T[] } | T[]
      return Array.isArray(result) ? result : (result.rows ?? [])
    }
    return (await target.all!(query)) as T[]
  }
  // Typed by the registry (the row's type names its notification); stored through its schema.
  const decode = (row: Row) =>
    ({
      id: row.id,
      type: row.type,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      readAt: row.read_at === null ? null : new Date(Number(row.read_at)),
      createdAt: new Date(Number(row.created_at)),
    }) as StoredNotification
  const list = (ids: string | readonly string[]) => {
    const all = typeof ids === 'string' ? [ids] : [...ids]
    return all.length ? sql`id in (${sql.join(all.map((id) => sql`${id}`), sql`, `)})` : sql`1 = 0`
  }

  const inbox = (notifiable: Notifiable): Inbox => {
    if (notifiable.onDemand) throw new CalderaError('database_on_demand', 'An on-demand recipient (route()) has no inbox.')
    const mine = sql`notifiable_type = ${notifiable.type} and notifiable_id = ${notifiable.id}`
    const count = async (query: SQL) => (await run<{ id: string }>(query)).length
    return {
      async list({ unread = false, limit = 20, before } = {}) {
        const size = Math.min(Math.max(1, Math.floor(limit)), 200)
        const unreadOnly = unread ? sql` and read_at is null` : sql``
        // Keyset pagination on (created_at, id): stable while new notifications arrive.
        const cursor = before
          ? sql` and (created_at, id) < (select created_at, id from ${table} where id = ${before} and ${mine})`
          : sql``
        const rows = await run<Row>(sql`select id, type, data, read_at, created_at from ${table} where ${mine}${unreadOnly}${cursor} order by created_at desc, id desc limit ${size}`)
        return rows.map(decode)
      },
      async find(id) {
        const [row] = await run<Row>(sql`select id, type, data, read_at, created_at from ${table} where ${mine} and id = ${id} limit 1`)
        return row ? decode(row) : undefined
      },
      async unreadCount() {
        const [row] = await run<{ n: number | string }>(sql`select count(*) as n from ${table} where ${mine} and read_at is null`)
        return Number(row?.n ?? 0)
      },
      markRead: (ids) => count(sql`update ${table} set read_at = ${Date.now()} where ${mine} and read_at is null and ${list(ids)} returning id`),
      markAllRead: () => count(sql`update ${table} set read_at = ${Date.now()} where ${mine} and read_at is null returning id`),
      markUnread: (ids) => count(sql`update ${table} set read_at = null where ${mine} and read_at is not null and ${list(ids)} returning id`),
      delete: (ids) => count(sql`delete from ${table} where ${mine} and ${list(ids)} returning id`),
    }
  }

  return {
    kind: 'caldera.channel',
    name: 'database',
    async send(message, { notifiable, id }) {
      const db = resolve()
      const data = JSON.stringify(message.data ?? null)
      const value = dialectOf(db) === 'pg' ? sql`${data}::jsonb` : sql`${data}`
      await run(
        sql`insert into ${table} (id, type, notifiable_type, notifiable_id, data, read_at, created_at) values (${id}, ${message.type}, ${notifiable.type}, ${notifiable.id}, ${value}, null, ${Date.now()}) on conflict (id) do nothing returning id`,
      )
    },
    inbox,
  }
}

/** The table's columns, as `caldera notifications:table` writes them. */
export const NOTIFICATIONS_TABLE_COLUMNS = ['id', 'type', 'notifiable_type', 'notifiable_id', 'data', 'read_at', 'created_at'] as const

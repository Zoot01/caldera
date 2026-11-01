import { CapabilityError, defineDriver } from '@caldera-js/core'
import { defaultDatabase, type Database } from '@caldera-js/db'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { gcra } from './gcra.js'
import type { CacheCapabilities, CacheStore, ThrottleRequest, ThrottleResult } from './store.js'

const configSchema = z.object({
  /** The cache table, created by `caldera cache:table` and your migrations. Default `caldera_cache`. */
  table: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'must be a plain lowercase table name')
    .default('caldera_cache'),
})
type DatabaseCacheConfig = z.infer<typeof configSchema>

type Dialect = 'pg' | 'sqlite'

/**
 * The cache in your own database, Laravel's default store: shared between servers with nothing else
 * to run, on Postgres, SQLite, libSQL and Cloudflare D1. Every operation that must be atomic is one
 * statement (D1 has no interactive transactions): `add` and `increment` are upserts, and a rate
 * limit's counters share a row updated by compare-and-swap. Writes join the current transaction, as
 * in Laravel. Expired rows are ignored when read and replaced when written; the store's `prune()` deletes them.
 */
export function databaseStore(config: DatabaseCacheConfig, options: { database?: () => Database<any>; now?: () => number } = {}): CacheStore & { prune(): Promise<number> } {
  const resolve = options.database ?? defaultDatabase
  const now = options.now ?? Date.now
  const table = sql.identifier(config.table)

  const dialectOf = (db: Database<any>): Dialect => {
    if (db.driver === 'postgres') return 'pg'
    if (db.driver === 'sqlite' || db.driver === 'sqlite-sync' || db.driver === 'd1') return 'sqlite'
    throw new CapabilityError(`database (${db.driver})`, 'the database cache', 'It needs Postgres, SQLite, libSQL or D1.')
  }
  const run = async <T>(query: (dialect: Dialect) => SQL): Promise<T[]> => {
    const db = resolve()
    const dialect = dialectOf(db)
    const target = db.current() as { execute?(q: SQL): Promise<unknown>; all?(q: SQL): unknown }
    if (dialect === 'pg') {
      const result = (await target.execute!(query(dialect))) as { rows?: T[] } | T[]
      return Array.isArray(result) ? result : (result.rows ?? [])
    }
    return (await target.all!(query(dialect))) as T[]
  }
  // Milliseconds since the epoch; bigint on Postgres, where `$n + integer` would be typed integer.
  const ms = (value: number, dialect: Dialect) => (dialect === 'pg' ? sql`${value}::bigint` : sql`${value}`)
  const expiry = (ttl: number | undefined) => (ttl === undefined ? null : now() + Math.round(ttl * 1000))
  const live = (at: number) => sql`(expires_at is null or expires_at > ${at})`

  const store: CacheStore & { prune(): Promise<number> } = {
    async get(key) {
      const [row] = await run<{ value: string }>(() => sql`select value from ${table} where key = ${key} and ${live(now())}`)
      return row?.value
    },
    async put(key, value, ttl) {
      const expires = expiry(ttl)
      await run((d) => sql`insert into ${table} (key, value, expires_at) values (${key}, ${value}, ${expires === null ? null : ms(expires, d)}) on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at returning key`)
    },
    async add(key, value, ttl) {
      const at = now()
      const expires = expiry(ttl)
      // Inserts, or takes over an expired row; a live row makes the update's WHERE false, so nothing returns.
      const rows = await run(
        (d) =>
          sql`insert into ${table} (key, value, expires_at) values (${key}, ${value}, ${expires === null ? null : ms(expires, d)}) on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at where ${table}.expires_at is not null and ${table}.expires_at <= ${ms(at, d)} returning key`,
      )
      return rows.length === 1
    },
    async forget(key) {
      return (await run(() => sql`delete from ${table} where key = ${key} returning key`)).length > 0
    },
    async forgetIf(key, expected) {
      return (await run(() => sql`delete from ${table} where key = ${key} and value = ${expected} and ${live(now())} returning key`)).length > 0
    },
    async increment(key, by, ttl) {
      const at = now()
      const expires = expiry(ttl)
      const [row] = await run<{ value: string | number }>((d) => {
        const current = d === 'pg' ? sql`${table}.value::bigint` : sql`cast(${table}.value as integer)`
        const asText = (value: SQL) => (d === 'pg' ? sql`(${value})::text` : sql`cast(${value} as text)`)
        const expired = sql`(${table}.expires_at is not null and ${table}.expires_at <= ${ms(at, d)})`
        // One statement: created at `by`, restarted when expired, otherwise added to (keeping its expiry).
        return sql`insert into ${table} (key, value, expires_at) values (${key}, ${String(by)}, ${expires === null ? null : ms(expires, d)}) on conflict (key) do update set value = case when ${expired} then excluded.value else ${asText(sql`${current} + ${by}`)} end, expires_at = case when ${expired} then excluded.expires_at else ${table}.expires_at end returning value`
      })
      return Number(row!.value)
    },
    async throttle(request: ThrottleRequest): Promise<ThrottleResult> {
      // All of a request's limits live in one row, so consuming them together is one compare-and-swap.
      const key = `throttle:${request.limits.map((l) => l.key).join('|')}`
      for (let attempt = 0; attempt < 20; attempt++) {
        const at = now()
        const [row] = await run<{ value: string; expires_at: number | string | null }>(() => sql`select value, expires_at from ${table} where key = ${key}`)
        const stored = row && (row.expires_at === null || Number(row.expires_at) > at) ? (JSON.parse(row.value) as (number | null)[]) : []
        const results = request.limits.map((limit, i) => gcra(limit, stored[i] ?? undefined, at, request.cost))
        const allowed = results.every((r) => r.allowed)
        const answer = { allowed, limits: results.map(({ allowed: _a, tat: _t, ...rest }) => rest) }
        if (!allowed || request.peek) return answer
        const next = JSON.stringify(results.map((r) => r.tat))
        const expires = Math.ceil(Math.max(...results.map((r) => r.tat)))
        const swapped = row
          ? await run((d) => sql`update ${table} set value = ${next}, expires_at = ${ms(expires, d)} where key = ${key} and value = ${row.value} returning key`)
          : await run((d) => sql`insert into ${table} (key, value, expires_at) values (${key}, ${next}, ${ms(expires, d)}) on conflict (key) do nothing returning key`)
        if (swapped.length === 1) return answer
        // Another request changed the row first: read it again.
        await new Promise((r) => setTimeout(r, Math.random() * 5 * (attempt + 1)))
      }
      throw new Error(`[caldera] database cache: rate limit row "${key}" kept changing under contention; try again.`)
    },
    async flush(prefix) {
      const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
      await run(() => sql`delete from ${table} where key like ${`${escaped}%`} escape '\\' returning key`)
    },
    async prune() {
      return (await run((d) => sql`delete from ${table} where expires_at is not null and expires_at <= ${ms(now(), d)} returning key`)).length
    },
  }
  return store
}

export const databaseCacheDriver = defineDriver<CacheStore, CacheCapabilities, DatabaseCacheConfig>({
  name: 'database',
  schema: configSchema,
  capabilities: { locks: true, atomicCounters: true, consistentReads: true, shared: true },
  create: (config) => databaseStore(config),
})

/** The table, as `caldera cache:table` writes it. */
export const CACHE_TABLE_COLUMNS = ['key', 'value', 'expires_at'] as const

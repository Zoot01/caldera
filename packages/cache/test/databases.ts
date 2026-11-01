import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { createDatabase, setDefaultDatabase, type Database } from '@caldera-js/db'
import { sql } from 'drizzle-orm'
import { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { Miniflare } from 'miniflare'
import pg from 'pg'
import { hasPostgres, startPostgres } from './postgres-server.js'

const PG_TABLE = 'create table caldera_cache (key text primary key, value text not null, expires_at bigint)'
const SQLITE_TABLE = 'create table caldera_cache (key text primary key, value text not null, expires_at integer)'

export interface DatabaseBackend {
  name: string
  /** Creates the table and makes the database the default (what the `database` cache driver uses). */
  use(): Promise<Database<any>>
}

/** libSQL (file), a real Postgres server (when installed) and D1 inside workerd (Miniflare). Started once per test file. */
export async function databaseBackends(): Promise<{ backends: DatabaseBackend[]; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'caldera-cache-db-'))
  const libsql = createClient({ url: `file:${join(dir, 'cache.db')}` })
  const sqliteDb = createDatabase(drizzleLibsql({ client: libsql }), { driver: 'sqlite' })
  await sqliteDb.client.run(sql.raw(SQLITE_TABLE))

  const mf = new Miniflare({ modules: true, script: 'export default { fetch: () => new Response(null) }', d1Databases: ['DB'], compatibilityDate: '2026-07-30' })
  const d1 = await mf.getD1Database('DB')
  const d1Db = createDatabase(drizzleD1(d1 as never), { driver: 'd1' })
  await d1.exec(SQLITE_TABLE)

  const pgServer = hasPostgres ? await startPostgres() : undefined
  const pool = pgServer ? new pg.Pool({ connectionString: pgServer.url, max: 10 }) : undefined
  const pgDb = pool ? createDatabase(drizzlePg({ client: pool }), { driver: 'postgres' }) : undefined
  if (pool) await pool.query(PG_TABLE)

  const backend = (name: string, db: Database<any>): DatabaseBackend => ({
    name,
    async use() {
      setDefaultDatabase(() => db)
      return db
    },
  })
  return {
    backends: [backend('database (libsql)', sqliteDb), backend('database (D1 on workerd)', d1Db), ...(pgDb ? [backend('database (postgres)', pgDb)] : [])],
    async stop() {
      setDefaultDatabase(undefined)
      libsql.close()
      await mf.dispose()
      await pool?.end()
      await pgServer?.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

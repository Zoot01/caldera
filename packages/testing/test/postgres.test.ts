import { join } from 'node:path'
import { createDatabase } from '@caldera/db'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateFresh } from '../src/index.js'
import { hasPostgres, startPostgres } from './postgres-server.js'

describe.runIf(hasPostgres)('a Postgres test database (real server)', () => {
  let server: Awaited<ReturnType<typeof startPostgres>>
  beforeAll(async () => {
    server = await startPostgres()
    const admin = new pg.Client({ connectionString: server.url })
    await admin.connect()
    await admin.query('create database app_test')
    await admin.end()
  }, 60_000)
  afterAll(async () => {
    await server?.stop()
  })
  const folder = join(import.meta.dirname, 'fixture-pg')

  it('is reset and migrated, again and again', async () => {
    const url = server.url.replace(/\/postgres$/, '/app_test')
    const pool = new pg.Pool({ connectionString: url })
    const db = createDatabase(drizzle({ client: pool }), { driver: 'postgres' })
    await migrateFresh(db as never, folder, url)
    await pool.query("insert into notes (body) values ('left over')")
    await migrateFresh(db as never, folder, url)
    expect((await pool.query('select count(*)::int as n from notes')).rows).toEqual([{ n: 0 }])
    await pool.end()
  })

  it('refuses a database whose name doesn’t say it’s for tests', async () => {
    const pool = new pg.Pool({ connectionString: server.url })
    const db = createDatabase(drizzle({ client: pool }), { driver: 'postgres' })
    await pool.query('create table keep (id int)')
    await expect(migrateFresh(db as never, folder, server.url)).rejects.toThrow('Refusing to reset the Postgres database "postgres" for tests: its name must contain "test"')
    expect((await pool.query("select count(*)::int as n from information_schema.tables where table_name = 'keep'")).rows).toEqual([{ n: 1 }])
    await pool.end()
  })
})

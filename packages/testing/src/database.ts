import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { CalderaError } from '@caldera-js/core'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'

// The test database without Vitest: setupApp uses it, and so can anything else that needs a fresh
// database (the Playwright server in tests/browser).

export interface DatabaseLike {
  readonly driver: string
  readonly client: { execute?(query: unknown): Promise<unknown>; run?(query: unknown): unknown; all?(query: unknown): unknown }
  readonly capabilities: { interactiveTransactions: boolean }
  beginTestTransaction(): Promise<{ rollback(): Promise<void> }>
}

export const isPostgres = (db: DatabaseLike) => db.driver === 'postgres' || db.driver === 'neon-http'

/** DATABASE_TEST_URL from the environment, else from the project's `.env` (Vitest doesn't load it). */
export function testDatabaseUrl(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DATABASE_TEST_URL) return env.DATABASE_TEST_URL
  const file = join(cwd, '.env')
  return (existsSync(file) && parseEnv(readFileSync(file, 'utf8')).DATABASE_TEST_URL) || undefined
}

/**
 * Runs every migration in `folder` against a fresh database. SQLite (a new file) starts empty;
 * Postgres is reset first, but only a database whose name contains "test", so a misconfigured
 * DATABASE_TEST_URL can never wipe real data.
 */
export async function migrateFresh(db: DatabaseLike, folder: string, url: string) {
  if (!existsSync(folder)) {
    throw new CalderaError('no_migrations', `No migrations in ${folder}: run \`caldera db:generate\` (tests build the database from your migrations), or pass setupApp(app, { database: false }).`)
  }
  const migrations = readMigrationFiles({ migrationsFolder: folder })
  const postgres = isPostgres(db)
  const run = (statement: string) => (postgres ? db.client.execute!(sql.raw(statement)) : db.client.run!(sql.raw(statement)))
  if (postgres) {
    const name = /\/([^/?]+)(?:\?|$)/.exec(url)?.[1] ?? ''
    if (!/test/i.test(name)) {
      throw new CalderaError('unsafe_test_database', `Refusing to reset the Postgres database "${name || url}" for tests: its name must contain "test" (set DATABASE_TEST_URL).`)
    }
    await run('drop schema if exists public cascade')
    await run('create schema public')
  }
  for (const migration of migrations) for (const statement of migration.sql) if (statement.trim()) await run(statement)
}


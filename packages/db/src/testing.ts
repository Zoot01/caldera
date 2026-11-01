import { CapabilityError } from '@caldera-js/core'
import { sql, type TablesRelationalConfig } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { defaultDatabase, setDefaultDatabase, type Database } from './database.js'
import { runSeeders, type SeederDefinition } from './seeders.js'

export interface UseDatabaseOptions {
  /** Called once per test file. */
  connect: () => Database<any> | Promise<Database<any>>
  /** Called once after connecting, e.g. to run migrations. */
  migrate?: (db: Database<any>) => unknown
  /** Seeded once after migrating; every test starts from this state. */
  seed?: readonly SeederDefinition[]
  /**
   * `transaction` (default): each test runs in a transaction that's rolled back. Fast.
   * `truncate`: tables are emptied and reseeded after each test. Use it for drivers without
   * interactive transactions, or when other connections (a browser test server) must see the data.
   */
  strategy?: 'transaction' | 'truncate'
}

/**
 * Gives each test in the file a clean, seeded database. Call it at the top of a test file (or a
 * `describe` block). The database also becomes the default for models while the tests run.
 * Tests in the same file must not run concurrently with the transaction strategy.
 */
export function useDatabase(options: UseDatabaseOptions): () => Database<any> {
  const strategy = options.strategy ?? 'transaction'
  let db: Database<any> | undefined
  let rollback: (() => Promise<void>) | undefined
  let previousDefault: (() => Database<any>) | undefined

  const seed = async () => {
    if (options.seed?.length) await runSeeders(options.seed, { environment: 'test', database: db! })
  }

  beforeAll(async () => {
    db = await options.connect()
    if (strategy === 'transaction' && !db.capabilities.interactiveTransactions) {
      throw new CapabilityError(db.driver, 'interactive transactions', "Use useDatabase({ strategy: 'truncate' }).")
    }
    try {
      const current = defaultDatabase()
      previousDefault = () => current
    } catch {
      previousDefault = undefined
    }
    setDefaultDatabase(() => db!)
    await options.migrate?.(db)
    await seed()
  })

  beforeEach(async () => {
    if (strategy === 'transaction') rollback = (await db!.beginTestTransaction()).rollback
  })

  afterEach(async () => {
    if (strategy === 'transaction') {
      await rollback?.()
      rollback = undefined
    } else {
      await truncateAll(db!)
      await seed()
    }
  })

  afterAll(() => {
    setDefaultDatabase(previousDefault)
  })

  return () => {
    if (!db) throw new Error('useDatabase(): the database is only available inside tests and hooks.')
    return db
  }
}

const TABLE_NAME = Symbol.for('drizzle:Name')
const TABLE_SCHEMA = Symbol.for('drizzle:Schema')

/** Empties every table in the client's relations. Postgres resets identities; SQLite disables FK checks while deleting. */
export async function truncateAll(db: Database<any>): Promise<void> {
  const client = db.client as { _?: { relations?: TablesRelationalConfig }; execute?: (q: unknown) => Promise<unknown>; run?: (q: unknown) => unknown }
  const relations = client._?.relations
  if (!relations) return
  const names = Object.values(relations).map((entry) => {
    const table = entry.table as unknown as Record<symbol, string | undefined>
    const name = `"${table[TABLE_NAME]!.replaceAll('"', '""')}"`
    return table[TABLE_SCHEMA] ? `"${table[TABLE_SCHEMA]!.replaceAll('"', '""')}".${name}` : name
  })
  if (names.length === 0) return
  if (db.driver === 'postgres' || db.driver === 'neon-http') {
    await client.execute!(sql.raw(`truncate table ${names.join(', ')} restart identity cascade`))
    return
  }
  await client.run!(sql.raw('pragma foreign_keys = off'))
  for (const name of names) await client.run!(sql.raw(`delete from ${name}`))
  await client.run!(sql.raw('pragma foreign_keys = on'))
}

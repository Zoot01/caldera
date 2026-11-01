import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CalderaError } from '@caldera-js/core'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { TestClient, type Requestable, type TestClientOptions } from './client.js'
import { isPostgres, migrateFresh, testDatabaseUrl, type DatabaseLike } from './database.js'

/** The parts of a Caldera app the helpers use (structural: the app's own @caldera-js/core copy fits). */
interface AppLike {
  readonly state: string
  readonly services: object
  boot(options?: { env?: Record<string, unknown> }): Promise<unknown>
  shutdown(): Promise<void>
}

type Faked<S> = { [K in keyof S]: S[K] extends { fake(...args: infer A): infer R } ? { args: A; result: R } : never }
type FakeableName<S> = { [K in keyof S]: S[K] extends { fake(...args: any[]): unknown } ? K : never }[keyof S] & string

export interface SetupAppOptions {
  /**
   * Env for the test app, over `process.env`. Defaults: NODE_ENV=test, a random APP_KEY, and
   * DATABASE_URL from DATABASE_TEST_URL (the environment, then `.env`), or a fresh SQLite file per
   * test file (never your dev database).
   */
  env?: Record<string, unknown>
  /**
   * The database (when the app has one): migrated once per test file from `migrations` (default
   * `drizzle/`, written by `caldera db:generate`), then each test runs in a transaction that's rolled
   * back. `strategy: 'truncate'` empties the tables after each test instead (for code using other
   * connections). `false`: leave the database alone.
   */
  database?: false | { migrations?: string; strategy?: 'transaction' | 'truncate'; seed?: readonly unknown[] }
}

export interface TestApp<A extends AppLike> {
  readonly app: A
  /** The app's services (available inside tests and hooks). */
  readonly services: A['services']
  /** The app's database. */
  db(): DatabaseLike
  /**
   * Fakes a service for this test: `t.fake('mail')` returns the mail fake, restored after the test.
   * Works for every service with `fake()`: mail, queue, events, notifications, storage.
   */
  fake<K extends FakeableName<A['services']>>(name: K, ...args: Faked<A['services']>[K]['args']): Faked<A['services']>[K]['result']
  /** An HTTP client for the app's `http` (src/http.ts), keeping cookies across requests. */
  client(http: Requestable, options?: TestClientOptions): TestClient
}

/**
 * Sets the app up for the tests in this file, Laravel's RefreshDatabase and fakes in one call:
 * boots it once (test env), migrates a fresh database, rolls each test back (and empties the cache), restores fakes after
 * each test, and shuts down at the end. Call it at the top of a test file.
 *
 * ```ts
 * const t = setupApp(app)
 * it('creates a post', async () => {
 *   const mail = t.fake('mail')
 *   ;(await t.client(http).post('/posts', { json: { title: 'Hi' } })).assertCreated()
 *   mail.assertNothingSent()
 * })
 * ```
 */
export function setupApp<A extends AppLike>(app: A, options: SetupAppOptions = {}): TestApp<A> {
  const restores: (() => void)[] = []
  let db: DatabaseLike | undefined
  let rollback: (() => Promise<void>) | undefined
  let tempDatabase: string | undefined
  const settings = options.database === false ? undefined : (options.database ?? {})

  beforeAll(async () => {
    const env: Record<string, unknown> = { ...process.env, NODE_ENV: 'test', APP_KEY: randomBytes(32).toString('base64url') }
    if (options.env?.DATABASE_URL === undefined) {
      const testUrl = testDatabaseUrl()
      if (testUrl) env.DATABASE_URL = testUrl
      else {
        tempDatabase = join(tmpdir(), `caldera-test-${process.pid}-${randomBytes(6).toString('hex')}.db`)
        env.DATABASE_URL = `file:${tempDatabase}`
      }
    }
    await app.boot({ env: { ...env, ...options.env } })
    db = (app.services as { db?: DatabaseLike }).db
    if (tempDatabase && db && isPostgres(db)) {
      throw new CalderaError('no_test_database', 'This app uses Postgres: set DATABASE_TEST_URL (in .env or the environment) to a database whose name contains "test", e.g. postgres://localhost:5432/app_test.')
    }
    if (db && settings) {
      await migrateFresh(db, resolve(settings.migrations ?? 'drizzle'), String(env.DATABASE_URL ?? ''))
      if (settings.seed?.length) await seed(db, settings.seed)
    }
  }, 60_000)

  beforeEach(async () => {
    if (db && settings && (settings.strategy ?? 'transaction') === 'transaction') {
      if (!db.capabilities.interactiveTransactions) {
        throw new CalderaError('capability_missing', `The ${db.driver} database can't wrap each test in a transaction: use setupApp(app, { database: { strategy: 'truncate' } }).`)
      }
      rollback = (await db.beginTestTransaction()).rollback
    }
  })

  afterEach(async () => {
    for (const restore of restores.splice(0).reverse()) restore()
    if (rollback) {
      await rollback()
      rollback = undefined
    } else if (db && settings?.strategy === 'truncate') {
      const { truncateAll } = await import('@caldera-js/db/testing')
      await truncateAll(db as never)
      if (settings.seed?.length) await seed(db, settings.seed)
    }
    // What the cache and the scheduler remember (rate-limit counts, locks, which schedules already ran
    // this minute) doesn't carry over: each test starts as on a fresh app, like its database.
    const services = app.services as { cache?: { flush(): Promise<void> }; scheduler?: { reset?(): void } }
    await services.cache?.flush()
    services.scheduler?.reset?.()
  })

  afterAll(async () => {
    await app.shutdown()
    if (tempDatabase) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${tempDatabase}${suffix}`, { force: true })
  })

  return {
    app,
    get services() {
      return app.services
    },
    db() {
      if (!db) throw new CalderaError('no_database', 'The app has no database (no databaseProvider), or the tests haven’t started yet.')
      return db
    },
    fake(name, ...args) {
      const service = (app.services as Record<string, { fake?(...a: unknown[]): { restore(): void } }>)[name]
      if (typeof service?.fake !== 'function') throw new CalderaError('not_fakeable', `The "${name}" service has no fake().`)
      const fake = service.fake(...args)
      restores.push(() => fake.restore())
      return fake as never
    },
    client: (http, clientOptions) => new TestClient(http, { services: app.services, ...clientOptions }),
  }
}

async function seed(db: DatabaseLike, seeders: readonly unknown[]) {
  const { runSeeders } = await import('@caldera-js/db/seeders')
  await runSeeders(seeders as never, { environment: 'test', database: db as never })
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { CalderaError, CapabilityError, defineProvider, type RegisterContext } from '@caldera-js/core'

/** What a database driver can do. Features that need a missing capability fail early (DESIGN principle 7). */
export interface DatabaseCapabilities {
  /** `BEGIN … COMMIT` with code running in between. D1 and neon-http can't. */
  interactiveTransactions: boolean
  /** Nested transactions via `SAVEPOINT`. */
  savepoints: boolean
  /** `INSERT … RETURNING`. MySQL can't. */
  returning: boolean
  /** Atomic multi-statement `batch()`. */
  batch: boolean
}

export const CAPABILITIES = {
  postgres: { interactiveTransactions: true, savepoints: true, returning: true, batch: false },
  /** Async SQLite clients (libsql). */
  sqlite: { interactiveTransactions: true, savepoints: true, returning: true, batch: false },
  /** Synchronous drivers (node:sqlite, better-sqlite3, bun:sqlite): Drizzle can't run async code in their transactions. */
  'sqlite-sync': { interactiveTransactions: false, savepoints: false, returning: true, batch: false },
  d1: { interactiveTransactions: false, savepoints: false, returning: true, batch: true },
  'neon-http': { interactiveTransactions: false, savepoints: false, returning: true, batch: true },
  mysql: { interactiveTransactions: true, savepoints: true, returning: false, batch: false },
} satisfies Record<string, DatabaseCapabilities>

export type Driver = keyof typeof CAPABILITIES

/** The shape Caldera needs from a Drizzle client: a `transaction` method. */
export interface TransactionalClient {
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>
}

type TxOf<Client> = Client extends { transaction<T>(fn: (tx: infer Tx) => Promise<T>): Promise<T> } ? Tx : Client

interface Scope {
  client: unknown
  afterCommit: (() => unknown)[]
  /** The test-wrapping transaction: it never commits, so callbacks can't wait for it. */
  test?: boolean
}

class TestRollback extends Error {}

export interface Database<Client extends TransactionalClient = TransactionalClient> {
  readonly name: string
  readonly driver: Driver
  readonly capabilities: DatabaseCapabilities
  /** The root Drizzle client. Prefer `current()` so code joins an open transaction. */
  readonly client: Client
  /** The active transaction in this async context, or the root client outside one. */
  current(): Client | TxOf<Client>
  inTransaction(): boolean
  /**
   * Runs `fn` in a transaction. Code anywhere inside (models, services) joins it via `current()`.
   * Nested calls become savepoints. `afterCommit` callbacks run once the outermost transaction commits.
   */
  transaction<T>(fn: (tx: TxOf<Client>) => Promise<T>): Promise<T>
  /** Runs `callback` after the current transaction commits, or right away outside one. Dropped on rollback. */
  afterCommit(callback: () => unknown): Promise<void>
  /**
   * Testing only: opens a transaction that wraps everything until the returned `rollback()`.
   * Code joins it even outside its async context (a test body), transactions inside become
   * savepoints, and after-commit callbacks fire when those inner transactions commit, as they
   * would in production. Use `useDatabase()` from `@caldera-js/db/testing` rather than this directly.
   */
  beginTestTransaction(): Promise<{ rollback(): Promise<void> }>
}

export interface CreateDatabaseOptions {
  driver: Driver
  name?: string
  /** Override individual capabilities, e.g. for a proxy driver. */
  capabilities?: Partial<DatabaseCapabilities>
}

export function createDatabase<Client extends TransactionalClient>(client: Client, options: CreateDatabaseOptions): Database<Client> {
  const name = options.name ?? 'default'
  const capabilities = { ...CAPABILITIES[options.driver], ...options.capabilities }
  const scope = new AsyncLocalStorage<Scope>()
  let testScope: Scope | undefined
  const active = () => scope.getStore() ?? testScope

  const database: Database<Client> = {
    name,
    driver: options.driver,
    capabilities,
    client,

    current() {
      return (active()?.client ?? client) as Client | TxOf<Client>
    },

    inTransaction() {
      const current = active()
      return current !== undefined && !current.test
    },

    async transaction(fn) {
      if (!capabilities.interactiveTransactions) {
        throw new CapabilityError(options.driver, 'interactive transactions', 'Use `db.client.batch([...])` for atomic writes.')
      }
      const parent = active()
      if (parent && !capabilities.savepoints) {
        throw new CapabilityError(options.driver, 'nested transactions (savepoints)')
      }
      const owner = (parent?.client ?? client) as TransactionalClient
      const own: Scope = { client: undefined, afterCommit: [] }

      const result = await owner.transaction((tx) => {
        own.client = tx
        return scope.run(own, () => fn(tx))
      })

      // A savepoint's callbacks wait for the outer commit; a rollback above would discard them.
      // The test transaction never commits, so directly inside it callbacks run now.
      if (parent && !parent.test) {
        parent.afterCommit.push(...own.afterCommit)
        return result
      }
      await runCallbacks(own.afterCommit)
      return result
    },

    async afterCommit(callback) {
      const current = active()
      if (current && !current.test) current.afterCommit.push(callback)
      else await callback()
    },

    async beginTestTransaction() {
      if (!capabilities.interactiveTransactions) {
        throw new CapabilityError(options.driver, 'interactive transactions', 'Use the `truncate` strategy, or isolated storage on D1.')
      }
      if (testScope) throw new CalderaError('test_transaction', 'A test transaction is already open on this database.')
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let opened!: () => void
      const ready = new Promise<void>((resolve) => (opened = resolve))
      const done = client
        .transaction(async (tx) => {
          testScope = { client: tx, afterCommit: [], test: true }
          opened()
          await released
          throw new TestRollback()
        })
        .catch((error: unknown) => {
          if (!(error instanceof TestRollback)) throw error
        })
        .finally(() => {
          testScope = undefined
        })
      await Promise.race([ready, done])
      return {
        async rollback() {
          release()
          await done
        },
      }
    },
  }
  return database
}

async function runCallbacks(callbacks: (() => unknown)[]) {
  const errors: unknown[] = []
  for (const callback of callbacks) {
    try {
      await callback()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Several after-commit callbacks failed.')
}

// Kept on globalThis, not in module state: the CLI (and duplicated installs) can load two
// copies of this package, and both must see the database the app's provider registered.
const DEFAULT = Symbol.for('caldera.db.defaultDatabase')
const registry = globalThis as { [DEFAULT]?: () => Database<any> }

/** Points models (and anything else using `defaultDatabase()`) at a database. The db provider calls this at boot. */
export function setDefaultDatabase(resolver: (() => Database<any>) | undefined) {
  registry[DEFAULT] = resolver
}

export function defaultDatabase(): Database<any> {
  const defaultResolver = registry[DEFAULT]
  if (!defaultResolver) {
    throw new CalderaError(
      'no_database',
      'No database is configured. Boot an app that uses databaseProvider(), or pass one explicitly with `Model.using(db)`.',
    )
  }
  return defaultResolver()
}

/**
 * Registers `db` (a `Database`) as a lazy singleton and makes it the default for models.
 * The connection is only opened when something first uses it.
 */
export function databaseProvider<Client extends TransactionalClient>(options: {
  /** The driver, or a function picking it per environment (D1 on Workers, libSQL elsewhere). */
  driver: Driver | ((app: RegisterContext<unknown>) => Driver)
  connect: (app: RegisterContext<unknown>) => Client
  capabilities?: Partial<DatabaseCapabilities>
}) {
  return defineProvider({
    name: 'db',
    register: (app) => ({
      db: app.singleton(() => createDatabase(options.connect(app), { driver: typeof options.driver === 'function' ? options.driver(app) : options.driver, capabilities: options.capabilities })),
    }),
    boot: (app) => setDefaultDatabase(() => app.services.db),
    shutdown: () => setDefaultDatabase(undefined),
  })
}

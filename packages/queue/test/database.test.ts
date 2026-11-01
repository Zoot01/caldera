import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { createDatabase, setDefaultDatabase, type Database } from '@caldera-js/db'
import { sql } from 'drizzle-orm'
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueue, defineJob, type Queue } from '../src/index.js'
import { databaseDriver, databaseQueue } from '../src/database.js'
import { hasPostgres, startPostgres } from './postgres-server.js'

const PG_TABLE = `create table caldera_jobs (
  id text primary key, queue text not null, envelope text not null, attempts integer not null default 0,
  timeout_seconds integer not null, available_at bigint not null, reserved_until bigint, reserved_by text,
  failed_at bigint, error text, created_at bigint not null)`
const SQLITE_TABLE = PG_TABLE.replaceAll('bigint', 'integer')

const runs: { id: string; attempt: number; worker?: string }[] = []
const Work = defineJob({
  name: 'db.work',
  payload: z.object({ id: z.string(), failTimes: z.number().default(0), crash: z.boolean().default(false) }),
  tries: 3,
  backoff: 0,
  timeout: 1,
  handle: async ({ id, failTimes }, ctx) => {
    runs.push({ id, attempt: ctx.attempt })
    if (ctx.attempt <= failTimes) throw new Error(`attempt ${ctx.attempt} fails`)
  },
})

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface Backend {
  name: string
  /** `rows` runs raw SQL, for the test's own checks. */
  setup(): Promise<{ db: Database<any>; rows(query: string): Promise<Record<string, unknown>[]>; teardown(): Promise<void> }>
}

let pgServer: Awaited<ReturnType<typeof startPostgres>> | undefined
beforeAll(async () => {
  if (hasPostgres) pgServer = await startPostgres()
}, 60_000)
afterAll(async () => {
  await pgServer?.stop()
})

const backends: Backend[] = [
  {
    name: 'sqlite (libsql file)',
    async setup() {
      const dir = mkdtempSync(join(tmpdir(), 'caldera-q-'))
      const client = createClient({ url: `file:${join(dir, 'q.db')}` })
      const db = createDatabase(drizzleLibsql({ client }), { driver: 'sqlite' })
      await db.client.run(sql.raw(SQLITE_TABLE))
      return {
        db,
        rows: async (query) => (await db.client.all(sql.raw(query))) as Record<string, unknown>[],
        teardown: async () => (client.close(), rmSync(dir, { recursive: true, force: true })),
      }
    },
  },
  ...(hasPostgres
    ? [
        {
          name: 'postgres (real server)',
          async setup() {
            const pool = new pg.Pool({ connectionString: pgServer!.url, max: 10 })
            const db = createDatabase(drizzlePg({ client: pool }), { driver: 'postgres' })
            await db.client.execute(sql.raw('drop table if exists caldera_jobs'))
            await db.client.execute(sql.raw(PG_TABLE))
            return { db, rows: async (query: string) => (await pool.query(query)).rows, teardown: () => pool.end() }
          },
        },
      ]
    : []),
]

describe.each(backends)('database queue on $name', (backend) => {
  let db: Database<any>
  let rows: (query: string) => Promise<Record<string, unknown>[]>
  let teardown: () => Promise<void>
  let queue: Queue
  beforeEach(async () => {
    ;({ db, rows, teardown } = await backend.setup())
    setDefaultDatabase(() => db)
    queue = createQueue({ default: 'db', connections: { db: { driver: 'database', pollInterval: 0.02 } } }, { drivers: [databaseDriver] })
    queue.register(Work)
    runs.length = 0
    return async () => {
      setDefaultDatabase(undefined)
      await teardown()
    }
  })

  const count = async (where = '1 = 1') => Number((await rows(`select count(*) as n from caldera_jobs where ${where}`))[0]!.n)

  it('runs a job, retries it in place, and deletes it when done', async () => {
    const worker = queue.work({ concurrency: 1 })
    await queue.dispatch(Work, { id: 'a', failTimes: 1 })
    await until(() => runs.length === 2)
    await until(async () => (await count()) === 0)
    await worker.stop()
    expect(runs.map((r) => r.attempt)).toEqual([1, 2])
  })

  it('honours delays', async () => {
    const worker = queue.work({ concurrency: 1 })
    const sent = Date.now()
    await queue.dispatch(Work, { id: 'later' }, { delay: 0.3 })
    await until(() => runs.length === 1)
    expect(Date.now() - sent).toBeGreaterThanOrEqual(290)
    await worker.stop()
  })

  it('keeps failed jobs, and can retry or forget them', async () => {
    const worker = queue.work({ concurrency: 1 })
    await queue.dispatch(Work, { id: 'bad', failTimes: 9 })
    await until(async () => (await count('failed_at is not null')) === 1)
    await worker.stop()
    const driver = queue.manager.use('db') as ReturnType<typeof databaseQueue>
    const [failed] = await driver.failed()
    expect(failed).toMatchObject({ job: 'db.work', attempts: 3, error: 'attempt 3 fails' })
    expect(await driver.retry([failed!.id])).toBe(1)
    runs.length = 0
    const again = queue.work({ concurrency: 1 })
    await until(async () => (await count('failed_at is not null')) === 1 && runs.length === 3)
    await again.stop()
    expect(runs.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(await driver.forget()).toBe(1)
    expect(await count()).toBe(0)
  })

  it('writes jobs through the open transaction: a rollback leaves no job', async () => {
    await db.transaction(async () => {
      await queue.dispatch(Work, { id: 'kept' })
    })
    await db
      .transaction(async () => {
        await queue.dispatch(Work, { id: 'dropped' })
        throw new Error('rollback')
      })
      .catch(() => {})
    expect(await count()).toBe(1)
  })

  it('picks up a job whose worker died, counting that as an attempt', async () => {
    await queue.dispatch(Work, { id: 'orphan' })
    // A worker claimed it and vanished: reserved, with the hold already expired.
    await rows(`update caldera_jobs set attempts = 1, reserved_by = 'dead:0', reserved_until = ${Date.now() - 1} returning id`)
    const worker = queue.work({ concurrency: 1 })
    await until(() => runs.length === 1)
    await worker.stop()
    expect(runs[0]).toMatchObject({ id: 'orphan', attempt: 2 })
  })

  it('never runs a job twice with many workers at once', async () => {
    const jobs = 60
    for (let i = 0; i < jobs; i++) await queue.dispatch(Work, { id: `j${i}` })
    // Two separate queues (as two processes would be), four workers each.
    const other = createQueue({ default: 'db', connections: { db: { driver: 'database', pollInterval: 0.02 } } }, { drivers: [databaseDriver] })
    other.register(Work)
    const workers = [queue.work({ concurrency: 4 }), other.work({ concurrency: 4 })]
    await until(() => runs.length >= jobs, 20_000)
    await until(async () => (await count()) === 0)
    await Promise.all(workers.map((w) => w.stop()))
    expect(runs).toHaveLength(jobs)
    expect(new Set(runs.map((r) => r.id)).size).toBe(jobs)
  }, 30_000)
})

it('refuses databases it can’t run on', () => {
  setDefaultDatabase(() => ({ driver: 'd1' }) as never)
  try {
    expect(() => databaseQueue({ table: 'caldera_jobs', pollInterval: '1s' }).work({ queues: ['default'], concurrency: 1 }, { process: async () => ({ status: 'done' }) })).toThrow(/doesn't support the database queue/)
  } finally {
    setDefaultDatabase(undefined)
  }
})

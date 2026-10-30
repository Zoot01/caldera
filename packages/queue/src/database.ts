import { CalderaError, CapabilityError, defineDriver, parseDuration, type Duration } from '@caldera/core'
import { defaultDatabase, type Database } from '@caldera/db'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { QueueCapabilities, QueueDriver, QueueRuntime, WorkOptions, Worker } from './driver.js'
import type { Envelope } from './envelope.js'

const configSchema = z.object({
  /** The jobs table, created by `caldera queue:table` and your migrations. Default `caldera_jobs`. */
  table: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'must be a plain lowercase table name')
    .default('caldera_jobs'),
  /** How often an idle worker checks for jobs. Default 1s. */
  pollInterval: z.union([z.number(), z.string()]).default('1s'),
})
type DatabaseQueueConfig = z.infer<typeof configSchema>

export interface FailedJob {
  id: string
  job: string
  queue: string
  attempts: number
  error: string | null
  failedAt: string
  envelope: Envelope
}

export interface DatabaseQueue extends QueueDriver {
  work(options: WorkOptions, runtime: QueueRuntime): Worker
  failed(): Promise<FailedJob[]>
  /** Puts failed jobs back on their queue (all of them, or these ids), attempts reset. */
  retry(ids?: readonly string[]): Promise<number>
  /** Deletes failed jobs (all, or these ids). */
  forget(ids?: readonly string[]): Promise<number>
}

type Dialect = 'pg' | 'sqlite'

interface Row {
  id: string
  envelope: string
  attempts: number | string
}

/**
 * Jobs in your own database, Laravel's default: durable with nothing else to run, on Postgres or
 * SQLite. Postgres workers claim with `FOR UPDATE SKIP LOCKED`, so they never wait on each other;
 * SQLite runs each claim as one atomic UPDATE. A claimed job is held for its timeout plus 30s: if a
 * worker dies, the job is picked up again and that counts as an attempt. Jobs dispatched inside a
 * transaction are written through it, so they exist only once it commits.
 */
export function databaseQueue(config: DatabaseQueueConfig, options: { database?: () => Database<any> } = {}): DatabaseQueue {
  const resolve = options.database ?? defaultDatabase
  const table = sql.identifier(config.table)
  const pollMs = parseDuration(config.pollInterval as Duration) * 1000

  const dialectOf = (db: Database<any>): Dialect => {
    if (db.driver === 'postgres') return 'pg'
    if (db.driver === 'sqlite' || db.driver === 'sqlite-sync') return 'sqlite'
    throw new CapabilityError(`database (${db.driver})`, 'the database queue', 'It needs Postgres or SQLite with a long-running worker; on the edge use Cloudflare Queues or QStash.')
  }

  const run = async (query: SQL, client?: unknown): Promise<Row[]> => {
    const db = resolve()
    const target = (client ?? db.current()) as { execute?(q: SQL): Promise<unknown>; all?(q: SQL): unknown }
    if (dialectOf(db) === 'pg') {
      const result = (await target.execute!(query)) as { rows?: Row[] } | Row[]
      return Array.isArray(result) ? result : (result.rows ?? [])
    }
    return (await target.all!(query)) as Row[]
  }

  const claim = async (queue: string, worker: string): Promise<Envelope | undefined> => {
    const db = resolve()
    const now = Date.now()
    const due = sql`queue = ${queue} and failed_at is null and available_at <= ${now} and (reserved_until is null or reserved_until < ${now})`
    const pick = dialectOf(db) === 'pg' ? sql`select id from ${table} where ${due} order by available_at, created_at limit 1 for update skip locked` : sql`select id from ${table} where ${due} order by available_at, created_at limit 1`
    // Against the root client, never a caller's transaction: a claim must commit on its own.
    // Postgres would type `$n + integer` as integer, which a millisecond timestamp overflows.
    const at = dialectOf(db) === 'pg' ? sql`${now}::bigint` : sql`${now}`
    const [row] = await run(
      sql`update ${table} set attempts = attempts + 1, reserved_by = ${worker}, reserved_until = ${at} + (timeout_seconds + 30) * 1000 where id = (${pick}) returning id, envelope, attempts`,
      db.client,
    )
    if (!row) return undefined
    const stored = JSON.parse(row.envelope) as Envelope
    return { ...stored, attempt: stored.attempt + Number(row.attempts) - 1 }
  }

  const settle = async (id: string, worker: string, change: SQL | 'delete') => {
    const db = resolve()
    const mine = sql`id = ${id} and reserved_by = ${worker}`
    await run(change === 'delete' ? sql`delete from ${table} where ${mine} returning id` : sql`update ${table} set ${change} where ${mine} returning id`, db.client)
  }

  const idFilter = (ids?: readonly string[]) => (ids?.length ? sql` and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql``)

  return {
    async push(envelope, delaySeconds) {
      const now = Date.now()
      // db.current(): inside a transaction the row commits (or rolls back) with it.
      await run(
        sql`insert into ${table} (id, queue, envelope, attempts, timeout_seconds, available_at, created_at) values (${envelope.id}, ${envelope.queue}, ${JSON.stringify(envelope)}, 0, ${Math.ceil(envelope.timeout)}, ${now + Math.round(delaySeconds * 1000)}, ${now}) returning id`,
      )
    },

    work(workOptions: WorkOptions, runtime: QueueRuntime): Worker {
      dialectOf(resolve())
      let stopped = false
      const wakers = new Set<() => void>()
      const sleep = (ms: number) =>
        new Promise<void>((done) => {
          const timer = setTimeout(finish, ms)
          function finish() {
            clearTimeout(timer)
            wakers.delete(finish)
            done()
          }
          wakers.add(finish)
        })

      const loop = async (slot: number) => {
        const worker = `${crypto.randomUUID().slice(0, 8)}:${slot}`
        while (!stopped) {
          let envelope: Envelope | undefined
          try {
            for (const queue of workOptions.queues) {
              envelope = await claim(queue, worker)
              if (envelope) break
            }
          } catch (error) {
            console.error('[caldera] database queue: claiming failed', error)
            await sleep(pollMs)
            continue
          }
          if (!envelope) {
            await sleep(pollMs)
            continue
          }
          const now = Date.now()
          // A worker died mid-job, more than once: give up without running it again.
          if (envelope.attempt > envelope.maxTries) {
            const error = `Job "${envelope.job}" was attempted ${envelope.attempt - 1} times without finishing (a worker stopped mid-job).`
            await settle(envelope.id, worker, sql`failed_at = ${now}, error = ${error}, reserved_until = null, reserved_by = null`)
            workOptions.onOutcome?.(envelope, { status: 'failed', error: new CalderaError('attempts_exhausted', error) })
            continue
          }
          const outcome = await runtime.process(envelope)
          workOptions.onOutcome?.(envelope, outcome)
          if (outcome.status === 'done') await settle(envelope.id, worker, 'delete')
          else if (outcome.status === 'retry') {
            await settle(envelope.id, worker, sql`available_at = ${Date.now() + Math.round(outcome.delaySeconds * 1000)}, reserved_until = null, reserved_by = null`)
          } else {
            const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            await settle(envelope.id, worker, sql`failed_at = ${Date.now()}, error = ${message.slice(0, 2000)}, reserved_until = null, reserved_by = null`)
          }
        }
      }
      const loops = Array.from({ length: Math.max(1, workOptions.concurrency) }, (_, slot) => loop(slot))
      return {
        async stop() {
          stopped = true
          for (const wake of [...wakers]) wake()
          await Promise.all(loops)
        },
      }
    },

    async failed() {
      const rows = (await run(sql`select id, envelope, attempts, error, failed_at from ${table} where failed_at is not null order by failed_at`, resolve().client)) as unknown as (Row & { error: string | null; failed_at: number | string })[]
      return rows.map((row) => {
        const envelope = JSON.parse(row.envelope) as Envelope
        return { id: row.id, job: envelope.job, queue: envelope.queue, attempts: Number(row.attempts), error: row.error, failedAt: new Date(Number(row.failed_at)).toISOString(), envelope }
      })
    },

    async retry(ids) {
      const rows = await run(sql`update ${table} set failed_at = null, error = null, attempts = 0, available_at = ${Date.now()} where failed_at is not null${idFilter(ids)} returning id`, resolve().client)
      return rows.length
    },

    async forget(ids) {
      const rows = await run(sql`delete from ${table} where failed_at is not null${idFilter(ids)} returning id`, resolve().client)
      return rows.length
    },
  }
}

export const databaseDriver = defineDriver<QueueDriver, QueueCapabilities, DatabaseQueueConfig>({
  name: 'database',
  schema: configSchema,
  capabilities: { delay: true, maxDelaySeconds: null, maxPayloadBytes: null, workers: true, durable: true },
  create: (config) => databaseQueue(config),
})

/** The table, as `caldera queue:table` writes it, for both dialects. Kept here so tests and docs agree. */
export const JOBS_TABLE_COLUMNS = ['id', 'queue', 'envelope', 'attempts', 'timeout_seconds', 'available_at', 'reserved_until', 'reserved_by', 'failed_at', 'error', 'created_at'] as const

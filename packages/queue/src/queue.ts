import { CalderaError, CapabilityError, createManager, parseDuration, type Duration, type DriverDefinition, type Manager, type RegisteredServices } from '@caldera/core'
import { bullmqDriver } from './bullmq.js'
import type { QueueCapabilities, QueueDriver, QueueRuntime, WorkOptions, Worker } from './driver.js'
import { memoryDriver, memoryQueue, syncDriver } from './drivers.js'
import type { Envelope, Outcome } from './envelope.js'
import type { AnyJob, PayloadOf, PendingJob } from './job.js'
import { processEnvelope } from './process.js'

export interface QueueConfig<N extends string = string> {
  default: NoInfer<N>
  connections: Record<N, { driver: string; [option: string]: unknown }>
}

export interface DispatchOptions<N extends string = string> {
  /** Wait before the first run. */
  delay?: Duration
  /** Queue only once the surrounding database transaction commits (dropped on rollback). */
  afterCommit?: boolean
  /** Overrides the job's queue. */
  queue?: string
  /** A connection other than the default. */
  connection?: N
}

export interface DispatchResult {
  id: string
  /** False when a `unique` job with the same key is already queued or running. */
  dispatched: boolean
}

/** What `unique` jobs need: an atomic add-if-absent with expiry, e.g. `c.var.cache`. */
export interface UniqueLocks {
  readonly capabilities: { locks: boolean }
  add(key: string, value: unknown, ttl?: Duration): Promise<boolean>
  forget(key: string): Promise<boolean>
}

export const QUEUE_DRIVERS: readonly DriverDefinition<QueueDriver, QueueCapabilities>[] = [syncDriver, memoryDriver, bullmqDriver]

export interface Queue<N extends string = string> {
  dispatch<J extends AnyJob>(job: J, payload: PayloadOf<J>, options?: DispatchOptions<N>): Promise<DispatchResult>
  /** Runs jobs one after another; a failure stops the rest. */
  chain(jobs: readonly PendingJob[]): { dispatch(options?: DispatchOptions<N>): Promise<DispatchResult> }
  /** Makes jobs known to this process, so it can run them (workers do this from `src/jobs`). */
  register(...jobs: AnyJob[]): void
  /** Starts consuming, on drivers with workers. */
  work(options?: Partial<WorkOptions> & { connection?: N }): Worker
  /** Runs one envelope, as a worker would (for drivers that deliver over HTTP or a platform queue). */
  process(envelope: Envelope): Promise<Outcome>
  /** Captures dispatched jobs instead of queueing them: all jobs, or only those listed. */
  fake(jobs?: readonly AnyJob[]): QueueFake
  readonly manager: Manager<QueueDriver, QueueCapabilities, N>
  /** Set by the provider at boot: what jobs see as `context.services`. */
  services: RegisteredServices
}

export interface QueueFake {
  dispatched<J extends AnyJob>(job?: J): { job: string; payload: PayloadOf<J>; envelope: Envelope; delaySeconds: number }[]
  assertDispatched<J extends AnyJob>(job: J, match?: (payload: PayloadOf<J>) => boolean, times?: number): void
  assertNotDispatched<J extends AnyJob>(job: J, match?: (payload: PayloadOf<J>) => boolean): void
  assertNothingDispatched(): void
  /** Runs the captured jobs (and the retries and chains they cause), for real. */
  drain(): Promise<{ envelope: Envelope; outcome: Outcome }[]>
  /** Stops faking. */
  restore(): void
}

export function createQueue<const N extends string>(
  config: QueueConfig<N>,
  options: { drivers?: readonly DriverDefinition<QueueDriver, QueueCapabilities>[]; locks?: () => UniqueLocks | undefined } = {},
): Queue<N> {
  const manager = createManager({ kind: 'queue', drivers: options.drivers ?? QUEUE_DRIVERS, config: { default: config.default, instances: config.connections } })
  const jobs = new Map<string, AnyJob>()
  const register = (job: AnyJob) => {
    const existing = jobs.get(job.name)
    if (existing && existing !== job) throw new CalderaError('job_duplicate', `Two different jobs are named "${job.name}".`, { job: job.name })
    jobs.set(job.name, job)
  }
  let fake: { only: Set<string> | null; store: ReturnType<typeof memoryQueue>; captured: { envelope: Envelope; delaySeconds: number }[] } | undefined

  const locks = () => {
    const store = options.locks?.()
    if (!store) throw new CalderaError('unique_needs_locks', 'Unique jobs need a cache with locks: queueProvider(..., { locks: (s) => s.cache }).')
    if (!store.capabilities.locks) throw new CapabilityError('cache', 'locks', 'Unique jobs need a store with atomic writes (Redis, or memory on one server).')
    return store
  }

  const runtime: QueueRuntime = {
    process: (envelope) =>
      processEnvelope(envelope, {
        jobs,
        services: queue.services,
        dispatchEnvelope: (next, delay) => send(next, delay, undefined),
        releaseUnique: async (key) => {
          await locks().forget(key)
        },
      }),
  }

  const send = async (envelope: Envelope, delaySeconds: number, connection: N | undefined) => {
    if (fake && (!fake.only || fake.only.has(envelope.job))) {
      fake.captured.push({ envelope, delaySeconds })
      await fake.store.push(envelope, delaySeconds, runtime)
      return
    }
    const name = connection ?? config.default
    const caps = manager.capabilities(name)
    if (caps.maxDelaySeconds !== null && delaySeconds > caps.maxDelaySeconds) {
      throw new CapabilityError(`queue.${name}`, `delays over ${caps.maxDelaySeconds}s`, 'Schedule the job closer to its run time, or use another connection.')
    }
    if (caps.maxPayloadBytes !== null) {
      const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length
      if (bytes > caps.maxPayloadBytes) {
        throw new CalderaError('payload_too_large', `Job "${envelope.job}" is ${bytes} bytes; queue.${name} accepts ${caps.maxPayloadBytes}. Pass ids, not data.`, { bytes })
      }
    }
    await manager.use(name).push(envelope, delaySeconds, runtime)
  }

  const envelopeFor = (job: AnyJob, payload: unknown, opts: DispatchOptions<N>, chain?: Envelope['chain']): Envelope => {
    // Validated now, so a bad payload fails where it was dispatched, not later in a worker.
    job.payload.parse(payload)
    const now = Date.now()
    return {
      v: 1,
      id: crypto.randomUUID(),
      job: job.name,
      queue: opts.queue ?? job.queue,
      payload,
      attempt: 1,
      maxTries: job.tries,
      backoff: [...job.backoff],
      timeout: job.timeout,
      retryUntil: job.retryUntil === null ? null : now + job.retryUntil * 1000,
      dispatchedAt: now,
      ...(chain?.length ? { chain } : {}),
    }
  }

  const dispatchEnvelope = async (job: AnyJob, envelope: Envelope, opts: DispatchOptions<N>): Promise<DispatchResult> => {
    register(job)
    const go = async (): Promise<DispatchResult> => {
      if (job.unique && !fake) {
        const key = `unique:${job.name}:${job.unique.key(job.payload.parse(envelope.payload))}`
        if (!(await locks().add(key, envelope.id, job.unique.for))) return { id: envelope.id, dispatched: false }
        envelope.uniqueKey = key
      }
      await send(envelope, opts.delay === undefined ? 0 : parseDuration(opts.delay), opts.connection)
      return { id: envelope.id, dispatched: true }
    }
    if (opts.afterCommit) {
      const db = defaultDatabase()
      if (db) {
        // Inside a transaction this waits for the commit (and is dropped on rollback); outside, it runs now.
        let result: DispatchResult = { id: envelope.id, dispatched: false }
        await db.afterCommit(async () => {
          result = await go()
        })
        return result
      }
    }
    return go()
  }

  const queue: Queue<N> = {
    services: {} as RegisteredServices,
    manager,
    register(...list) {
      for (const job of list) register(job)
    },
    // async, so an invalid payload is a rejected promise, never a synchronous throw.
    async dispatch(job, payload, opts = {}) {
      return dispatchEnvelope(job, envelopeFor(job, payload, opts), opts)
    },
    chain(pending) {
      return {
        async dispatch(opts = {}) {
          const [first, ...rest] = pending
          if (!first) throw new CalderaError('chain_empty', 'chain() needs at least one job.')
          for (const p of pending) {
            register(p.job)
            p.job.payload.parse(p.payload)
          }
          const chain = rest.map((p) => ({ job: p.job.name, queue: p.job.queue, payload: p.payload }))
          return dispatchEnvelope(first.job, envelopeFor(first.job, first.payload, opts, chain), opts)
        },
      }
    },
    work(opts = {}) {
      const name = opts.connection ?? config.default
      const driver = manager.use(name)
      if (!driver.work) throw new CapabilityError(`queue.${name} (${manager.describe().instances.find((i) => i.name === name)?.driver})`, 'workers', 'Workers need a driver like bullmq.')
      return driver.work({ queues: opts.queues ?? ['default'], concurrency: opts.concurrency ?? 1, ...(opts.onOutcome ? { onOutcome: opts.onOutcome } : {}) }, runtime)
    },
    process: (envelope) => runtime.process(envelope),
    fake(only) {
      const state = { only: only ? new Set(only.map((j) => j.name)) : null, store: memoryQueue(), captured: [] as { envelope: Envelope; delaySeconds: number }[] }
      fake = state
      const matching = <J extends AnyJob>(job: J, match?: (payload: PayloadOf<J>) => boolean) =>
        state.captured.filter((c) => c.envelope.job === job.name && (!match || match(c.envelope.payload as PayloadOf<J>)))
      return {
        dispatched: (job) =>
          state.captured
            .filter((c) => !job || c.envelope.job === job.name)
            .map((c) => ({ job: c.envelope.job, payload: c.envelope.payload as never, envelope: c.envelope, delaySeconds: c.delaySeconds })),
        assertDispatched(job, match, times) {
          const found = matching(job, match).length
          if (times === undefined ? found === 0 : found !== times) {
            throw new CalderaError('assertion_failed', `Expected "${job.name}" to be dispatched${match ? ' with a matching payload' : ''} ${times ?? 'at least once'} time(s); it was ${found}.`)
          }
        },
        assertNotDispatched(job, match) {
          const found = matching(job, match).length
          if (found > 0) throw new CalderaError('assertion_failed', `Expected "${job.name}" not to be dispatched${match ? ' with a matching payload' : ''}; it was ${found} time(s).`)
        },
        assertNothingDispatched() {
          if (state.captured.length) throw new CalderaError('assertion_failed', `Expected no jobs; got ${state.captured.map((c) => c.envelope.job).join(', ')}.`)
        },
        drain: () => state.store.drain(runtime),
        restore() {
          if (fake === state) fake = undefined
        },
      }
    },
  }
  return queue
}

interface AfterCommitDatabase {
  afterCommit(callback: () => unknown): Promise<void>
}

// The app's database, as @caldera/db registers it, read without depending on that package.
function defaultDatabase(): AfterCommitDatabase | undefined {
  const resolver = (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.db.defaultDatabase')] as (() => AfterCommitDatabase) | undefined
  try {
    return resolver?.()
  } catch {
    return undefined
  }
}

const DEFAULT = Symbol.for('caldera.queue.default')
const registry = globalThis as { [DEFAULT]?: Queue<any> }

/** The app's queue (set by `queueProvider`), for `dispatch()` outside a request. */
export function setDefaultQueue(queue: Queue<any> | undefined) {
  registry[DEFAULT] = queue
}

export function defaultQueue(): Queue<any> {
  const queue = registry[DEFAULT]
  if (!queue) throw new CalderaError('no_queue', 'No queue is configured. Add queueProvider() to the app, or use c.var.queue.')
  return queue
}

/** `await dispatch(SendWelcomeEmail, { userId })`, on the app's queue. */
export function dispatch<J extends AnyJob>(job: J, payload: PayloadOf<J>, options?: DispatchOptions): Promise<DispatchResult> {
  return defaultQueue().dispatch(job, payload, options)
}

/** `await chain([A.with(a), B.with(b)]).dispatch()`, on the app's queue. */
export function chain(jobs: readonly PendingJob[]) {
  return defaultQueue().chain(jobs)
}

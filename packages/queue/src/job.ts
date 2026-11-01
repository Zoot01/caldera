import { CalderaError, parseDuration, type Duration, type RegisteredConfig, type RegisteredServices } from '@caldera/core'
import type { z } from 'zod'

export interface JobContext {
  /** 1 on the first run. */
  readonly attempt: number
  readonly maxTries: number
  /** The envelope id, stable across retries. */
  readonly jobId: string
  /** The batch this job belongs to (or reports on, for then/catch/finally jobs). */
  readonly batchId: string | null
  /** Aborts when the job's `timeout` passes. Pass it to fetch, database calls and so on. */
  readonly signal: AbortSignal
  /** The app's services (db, cache, mail…), typed once `caldera generate` has registered the app. */
  readonly services: RegisteredServices
  /** The app's settings (src/config), as `c.var.config` in a route: `ctx.config.app.url` for links in mail. */
  readonly config: RegisteredConfig
  /** Stop retrying: the job fails now, and its `failed` hook runs. */
  fail(reason?: string): never
  /** Try again later (counts as an attempt). */
  release(delay?: Duration): never
}

/** Wraps a job's handling, like Laravel's job middleware: rate limits, overlap locks, logging. */
export type JobMiddleware = (context: JobContext & { job: AnyJob; payload: unknown }, next: () => Promise<void>) => Promise<void>

export interface JobOptions<P extends z.ZodType> {
  /** Stable wire id, e.g. `users.send-welcome`. Renaming it orphans jobs already queued. */
  name: string
  /** Validated when dispatched and again when handled (the code may have changed in between). */
  payload: P
  /** Queue name. Default `default`. */
  queue?: string
  /** Runs in total, including the first. Default 1. */
  tries?: number
  /** Seconds (or durations) to wait before each retry: `[1, 10, 60]`. The last one repeats. */
  backoff?: Duration | readonly Duration[]
  /** Abort after this long. Default 60s. */
  timeout?: Duration
  /** Stop retrying once this long has passed since dispatch, whatever `tries` says. */
  retryUntil?: Duration
  /** At most one queued or running job per key. Needs a cache store with locks. */
  unique?: { key: (payload: z.output<P>) => string; for: Duration }
  middleware?: readonly JobMiddleware[]
  handle(payload: z.output<P>, context: JobContext): Promise<void> | void
  /** After the last attempt fails (or `fail()`), e.g. to tell someone. */
  failed?(payload: z.output<P>, error: unknown, context: { services: RegisteredServices; config: RegisteredConfig }): Promise<void> | void
}

export interface JobDefinition<P extends z.ZodType = z.ZodType> {
  readonly kind: 'caldera.job'
  readonly name: string
  readonly payload: P
  readonly queue: string
  readonly tries: number
  /** Seconds before retry 1, 2, … */
  readonly backoff: readonly number[]
  /** Seconds. */
  readonly timeout: number
  /** Seconds after dispatch, or null. */
  readonly retryUntil: number | null
  readonly unique: { key: (payload: z.output<P>) => string; for: number } | null
  readonly middleware: readonly JobMiddleware[]
  readonly handle: JobOptions<P>['handle']
  readonly failed: JobOptions<P>['failed'] | undefined
  /** A payload bound to this job, for `chain([...])`. */
  with(payload: z.input<P>): PendingJob
  /**
   * This job as an event listener (`@caldera/events`): `listen(UserRegistered, SendWelcome.fromEvent((e) => ({ userId: e.userId })))`.
   * Each emit dispatches the job with the mapped payload.
   */
  fromEvent<E>(map: (event: E) => z.input<P>): { readonly kind: 'caldera.queued-listener'; readonly job: JobDefinition<P>; map(payload: E): unknown }
}

export type AnyJob = JobDefinition<any>
export type PayloadOf<J> = J extends JobDefinition<infer P> ? z.input<P> : never

export interface PendingJob {
  readonly job: AnyJob
  readonly payload: unknown
}

export function defineJob<P extends z.ZodType>(options: JobOptions<P>): JobDefinition<P> {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(options.name)) {
    throw new CalderaError('job_name_invalid', `Job name "${options.name}" should be a stable id like "users.send-welcome".`)
  }
  const tries = options.tries ?? 1
  if (!Number.isInteger(tries) || tries < 1) throw new CalderaError('job_tries_invalid', `Job "${options.name}": tries must be a whole number >= 1.`)
  const backoff = options.backoff === undefined ? [0] : (Array.isArray(options.backoff) ? options.backoff : [options.backoff]).map((d) => parseDuration(d as Duration))
  const job: JobDefinition<P> = {
    kind: 'caldera.job',
    name: options.name,
    payload: options.payload,
    queue: options.queue ?? 'default',
    tries,
    backoff,
    timeout: parseDuration(options.timeout ?? 60),
    retryUntil: options.retryUntil === undefined ? null : parseDuration(options.retryUntil),
    unique: options.unique ? { key: options.unique.key, for: parseDuration(options.unique.for) } : null,
    middleware: options.middleware ?? [],
    handle: options.handle,
    failed: options.failed,
    with: (payload) => ({ job, payload }),
    fromEvent: (map) => ({ kind: 'caldera.queued-listener', job, map }),
  }
  return job
}

/** Seconds to wait before the retry that follows `attempt` (1-based). */
export function backoffFor(backoff: readonly number[], attempt: number): number {
  return backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0
}

/** Thrown by `context.fail()`. */
export class JobFailedError extends CalderaError {
  constructor(job: string, reason?: string) {
    super('job_failed', reason ?? `Job "${job}" failed.`, { job })
  }
}

/** Thrown by `context.release()`. */
export class JobReleasedError extends CalderaError {
  readonly delay: number

  constructor(job: string, delay: number) {
    super('job_released', `Job "${job}" was released for ${delay}s.`, { job, delay })
    this.delay = delay
  }
}

export class JobTimeoutError extends CalderaError {
  constructor(job: string, seconds: number) {
    super('job_timeout', `Job "${job}" timed out after ${seconds}s.`, { job, timeout: seconds })
  }
}

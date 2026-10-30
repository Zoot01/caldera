import { CalderaError, parseDuration, type RegisteredServices } from '@caldera/core'
import type { Envelope, Outcome } from './envelope.js'
import { backoffFor, JobFailedError, JobReleasedError, JobTimeoutError, type AnyJob, type JobContext } from './job.js'

export interface ProcessContext {
  jobs: { get(name: string): AnyJob | undefined }
  services: RegisteredServices
  /** Queues the next job of a chain. */
  dispatchEnvelope(envelope: Envelope, delaySeconds: number): Promise<void>
  /** Releases a `unique` lock. */
  releaseUnique(key: string): Promise<void>
  now?: () => number
}

/**
 * Runs one attempt of one job and says what should happen next. The only place retry, backoff,
 * timeout, `failed()` and chain rules live (Laravel's Worker::process); drivers just act on the outcome.
 */
export async function processEnvelope(envelope: Envelope, context: ProcessContext): Promise<Outcome> {
  const now = context.now ?? Date.now
  const job = context.jobs.get(envelope.job)
  if (!job) {
    // No retry can fix this: the worker doesn't have the job's code (renamed or not deployed).
    return { status: 'failed', error: new CalderaError('job_missing', `No job named "${envelope.job}" is registered in this worker.`, { job: envelope.job }) }
  }

  const finish = async (error: unknown) => {
    if (envelope.uniqueKey) await context.releaseUnique(envelope.uniqueKey).catch(() => {})
    if (error === undefined) return
    try {
      const payload = job.payload.safeParse(envelope.payload)
      await job.failed?.(payload.success ? payload.data : envelope.payload, error, { services: context.services })
    } catch (hookError) {
      console.error(`[caldera] failed() hook of "${job.name}" threw`, hookError)
    }
  }

  const parsed = job.payload.safeParse(envelope.payload)
  if (!parsed.success) {
    const error = new CalderaError('payload_invalid', `Job "${job.name}" got a payload that no longer matches its schema.`, { issues: parsed.error.issues })
    await finish(error)
    return { status: 'failed', error }
  }

  const controller = new AbortController()
  const jobContext: JobContext = {
    attempt: envelope.attempt,
    maxTries: envelope.maxTries,
    jobId: envelope.id,
    signal: controller.signal,
    services: context.services,
    fail: (reason) => {
      throw new JobFailedError(job.name, reason)
    },
    release: (delay = 0) => {
      throw new JobReleasedError(job.name, parseDuration(delay))
    },
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const run = async () => {
      // Middleware wraps the handler, outermost first.
      const chain = job.middleware.reduceRight<() => Promise<void>>(
        (next, middleware) => () => middleware({ ...jobContext, job, payload: parsed.data }, next),
        async () => {
          await job.handle(parsed.data, jobContext)
        },
      )
      await chain()
    }
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new JobTimeoutError(job.name, envelope.timeout)
        controller.abort(error)
        reject(error)
      }, envelope.timeout * 1000)
    })
    await Promise.race([run(), timedOut])
  } catch (error) {
    clearTimeout(timer)
    const exhausted = envelope.attempt >= envelope.maxTries
    const expired = envelope.retryUntil !== null && now() >= envelope.retryUntil
    // fail() is final; anything else (including release()) is retried while attempts and time remain.
    if (error instanceof JobFailedError || exhausted || expired) {
      await finish(error)
      return { status: 'failed', error }
    }
    const delaySeconds = error instanceof JobReleasedError ? error.delay : backoffFor(envelope.backoff, envelope.attempt)
    return { status: 'retry', delaySeconds, error }
  }
  clearTimeout(timer)

  await finish(undefined)
  const [next, ...rest] = envelope.chain ?? []
  if (next) {
    await context.dispatchEnvelope(
      {
        ...envelope,
        id: crypto.randomUUID(),
        job: next.job,
        queue: next.queue,
        payload: next.payload,
        attempt: 1,
        ...defaultsFor(context.jobs.get(next.job), envelope, now()),
        chain: rest,
        dispatchedAt: now(),
      },
      0,
    )
  }
  return { status: 'done' }
}

/** Retry settings for the next job of a chain come from that job's own definition. */
function defaultsFor(job: AnyJob | undefined, fallback: Envelope, now: number) {
  if (!job) return { maxTries: 1, backoff: [0], timeout: fallback.timeout, retryUntil: null, uniqueKey: undefined }
  return { maxTries: job.tries, backoff: [...job.backoff], timeout: job.timeout, retryUntil: job.retryUntil === null ? null : now + job.retryUntil * 1000, uniqueKey: undefined }
}

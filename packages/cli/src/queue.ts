import { CalderaError } from '@caldera/core'
import { loadApp, projectEnv } from './describe.js'
import { CONVENTIONS, exportsOfKind, jobFiles, type Project } from './project.js'

/** The parts of `@caldera/queue`'s Queue the worker uses, so the CLI doesn't depend on that package. */
interface QueueLike {
  register(...jobs: unknown[]): void
  work(options: { queues?: string[]; concurrency?: number; connection?: string; onOutcome?(envelope: WorkerEnvelope, outcome: WorkerOutcome): void }): { stop(): Promise<void> }
}
export interface WorkerEnvelope {
  id: string
  job: string
  queue: string
  attempt: number
  maxTries: number
}
export type WorkerOutcome = { status: 'done' } | { status: 'retry'; delaySeconds: number; error: unknown } | { status: 'failed'; error: unknown }

export interface WorkerEvent {
  type: 'started' | 'job' | 'stopped'
  jobs?: string[]
  job?: string
  id?: string
  attempt?: number
  status?: WorkerOutcome['status']
  delaySeconds?: number
  error?: string
}

/** Every job exported from src/jobs, with where it's defined. */
export async function loadJobs(project: Project): Promise<{ file: string; exportName: string; job: { name: string; queue: string; tries: number; timeout: number } }[]> {
  const found = []
  for (const file of jobFiles(project)) {
    for (const { exportName, value } of exportsOfKind<{ name: string; queue: string; tries: number; timeout: number }>(await project.load(file), 'caldera.job')) {
      found.push({ file, exportName, job: value })
    }
  }
  return found
}

/**
 * `caldera queue:work`: boots the app with its `.env`, registers every job in src/jobs, and consumes
 * until stopped. On stop it lets running jobs finish (up to their timeout), then shuts the app down.
 */
export async function startWorker(
  project: Project,
  options: { queues?: string[]; concurrency?: number; connection?: string; onEvent?: (event: WorkerEvent) => void } = {},
): Promise<{ stop(): Promise<void> }> {
  const emit = options.onEvent ?? (() => {})
  const app = await loadApp(project)
  await app.boot({ env: projectEnv(project) })
  const queue = (app as unknown as { services: { queue?: QueueLike } }).services.queue
  if (!queue) throw new CalderaError('queue_not_configured', `${CONVENTIONS.app} has no queue: add queueProvider() to its providers.`)

  const names: string[] = []
  for (const { job } of await loadJobs(project)) {
    queue.register(job)
    names.push(job.name)
  }
  const worker = queue.work({
    ...(options.queues ? { queues: options.queues } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    onOutcome: (envelope, outcome) =>
      emit({
        type: 'job',
        job: envelope.job,
        id: envelope.id,
        attempt: envelope.attempt,
        status: outcome.status,
        ...(outcome.status === 'retry' ? { delaySeconds: outcome.delaySeconds } : {}),
        ...(outcome.status !== 'done' ? { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) } : {}),
      }),
  })
  emit({ type: 'started', jobs: names })
  return {
    async stop() {
      await worker.stop()
      await app.shutdown()
      emit({ type: 'stopped' })
    },
  }
}

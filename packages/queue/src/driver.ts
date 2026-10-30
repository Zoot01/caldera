import type { Envelope, Outcome } from './envelope.js'

/** Given to drivers so they can run jobs (sync, memory) without knowing how a job is processed. */
export interface QueueRuntime {
  process(envelope: Envelope): Promise<Outcome>
}

export interface WorkOptions {
  queues: readonly string[]
  /** Jobs handled at once by this worker. */
  concurrency: number
  /** Called after every attempt, for logging. */
  onOutcome?(envelope: Envelope, outcome: Outcome): void
}

export interface Worker {
  /** Finishes running jobs (up to their timeout), then stops taking new ones. */
  stop(): Promise<void>
}

/** A queue backend. Retry rules live in processEnvelope; a driver moves envelopes and acts on outcomes. */
export interface QueueDriver {
  push(envelope: Envelope, delaySeconds: number, runtime: QueueRuntime): Promise<void>
  /** Long-running consumption, for drivers with workers (BullMQ). */
  work?(options: WorkOptions, runtime: QueueRuntime): Worker
  close?(): Promise<void>
}

export interface QueueCapabilities {
  /** Honours `delay` (sync runs at once). */
  delay: boolean
  maxDelaySeconds: number | null
  maxPayloadBytes: number | null
  /** Has workers (`caldera queue:work`). */
  workers: boolean
  /** Survives a restart and is shared between servers. */
  durable: boolean
}

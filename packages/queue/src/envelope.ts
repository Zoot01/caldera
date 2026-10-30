/**
 * What goes over the wire: plain JSON, so any backend (BullMQ, Cloudflare Queues, QStash) and any
 * language can read it. Payloads carry ids, not models.
 */
export interface Envelope {
  v: 1
  id: string
  job: string
  queue: string
  payload: unknown
  /** The attempt about to run, 1-based. */
  attempt: number
  maxTries: number
  backoff: number[]
  timeout: number
  /** Epoch ms after which no retry happens, or null. */
  retryUntil: number | null
  dispatchedAt: number
  /** Jobs to dispatch, in order, once this one succeeds. */
  chain?: { job: string; queue: string; payload: unknown }[]
  /** The unique lock to release when the job finishes. */
  uniqueKey?: string
  /** The batch this job counts toward. */
  batchId?: string
  /** Set on a batch's then/catch/finally jobs: the batch they report on (they don't count toward it). */
  batchCallbackOf?: string
}

/** What happened to one attempt. Drivers turn this into ack, retry or dead-letter. */
export type Outcome =
  | { status: 'done' }
  | { status: 'retry'; delaySeconds: number; error: unknown }
  | { status: 'failed'; error: unknown }

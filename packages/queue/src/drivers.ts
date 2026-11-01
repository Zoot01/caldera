import { CalderaError, defineDriver } from '@caldera-js/core'
import type { QueueCapabilities, QueueDriver, QueueRuntime } from './driver.js'
import type { Envelope, Outcome } from './envelope.js'

/**
 * Runs each job as it's dispatched, in the dispatching request. Delays are ignored and a failure is
 * rethrown to the caller (after `failed()`), as in Laravel: right for development and tests.
 */
export const syncDriver = defineDriver<QueueDriver, QueueCapabilities>({
  name: 'sync',
  capabilities: { delay: false, maxDelaySeconds: null, maxPayloadBytes: null, workers: false, durable: false },
  create: () => ({
    async push(envelope, _delay, runtime) {
      let current: Envelope | undefined = envelope
      // Retries run inline too, without waiting out the backoff.
      while (current) {
        const outcome: Outcome = await runtime.process(current)
        if (outcome.status === 'done') return
        if (outcome.status === 'failed') throw outcome.error
        current = { ...current, attempt: current.attempt + 1 }
      }
    },
  }),
})

/**
 * Runs each job right after the current response, in the same process (Laravel's `deferred`): no
 * infrastructure, and the request doesn't wait. On Workers it uses `waitUntil` so the runtime keeps
 * the isolate alive (create the app with `asyncContext` so the request can be found). Retries run at
 * once; failures are logged, never thrown to the request. For short work only: nothing survives a crash.
 */
export const deferredDriver = defineDriver<QueueDriver, QueueCapabilities>({
  name: 'deferred',
  capabilities: { delay: false, maxDelaySeconds: null, maxPayloadBytes: null, workers: false, durable: false },
  create: () => ({
    async push(envelope, _delay, runtime) {
      const run = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
        let current: Envelope | undefined = envelope
        while (current) {
          const outcome: Outcome = await runtime.process(current)
          if (outcome.status === 'done') return
          if (outcome.status === 'failed') {
            console.error(`[caldera] deferred job "${current.job}" failed`, outcome.error)
            return
          }
          current = { ...current, attempt: current.attempt + 1 }
        }
      })
      const waitUntil = runtime.waitUntil?.()
      if (waitUntil) waitUntil(run)
      else void run.catch((error: unknown) => console.error('[caldera] deferred job crashed', error))
    },
  }),
})

export interface MemoryQueue extends QueueDriver {
  /** Envelopes waiting, oldest first. */
  pending(): readonly { envelope: Envelope; availableAt: number }[]
  /**
   * Runs everything queued, including retries and chained jobs it queues, until empty. Delays are
   * not waited out. Returns every outcome, in order.
   */
  drain(runtime: QueueRuntime, options?: { maxJobs?: number }): Promise<{ envelope: Envelope; outcome: Outcome }[]>
}

/** Keeps jobs in this process until `drain()`. For tests. */
export function memoryQueue(): MemoryQueue {
  const items: { envelope: Envelope; availableAt: number }[] = []
  const queue: MemoryQueue = {
    async push(envelope, delaySeconds) {
      items.push({ envelope, availableAt: Date.now() + delaySeconds * 1000 })
      items.sort((a, b) => a.availableAt - b.availableAt)
    },
    pending: () => items,
    async drain(runtime, { maxJobs = 1000 } = {}) {
      const results: { envelope: Envelope; outcome: Outcome }[] = []
      while (items.length) {
        if (results.length >= maxJobs) throw new CalderaError('drain_limit', `drain() ran ${maxJobs} jobs and the queue still isn't empty: is a job re-queueing itself?`)
        const { envelope } = items.shift()!
        const outcome = await runtime.process(envelope)
        results.push({ envelope, outcome })
        if (outcome.status === 'retry') await queue.push({ ...envelope, attempt: envelope.attempt + 1 }, outcome.delaySeconds, runtime)
      }
      return results
    },
  }
  return queue
}

export const memoryDriver = defineDriver<QueueDriver, QueueCapabilities>({
  name: 'memory',
  capabilities: { delay: true, maxDelaySeconds: null, maxPayloadBytes: null, workers: false, durable: false },
  create: () => memoryQueue(),
})

/** Re-exported for drivers that only need the runtime type. */
export type { QueueRuntime }

import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let mf: Miniflare
let bundle: string

beforeAll(async () => {
  const result = await build({
    entryPoints: [join(import.meta.dirname, 'fixtures/cf-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    write: false,
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0]!.text
  mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    kvNamespaces: ['RESULTS'],
    queueProducers: { JOBS: { queueName: 'jobs' } },
    // No platform retries at all: every retry must come from the job's own tries.
    queueConsumers: { jobs: { maxBatchTimeout: 0.2, maxRetries: 0 } },
  })
  await mf.ready
}, 60_000)
afterAll(async () => {
  await mf?.dispose()
})

type Kv = { get(key: string): Promise<string | null> }
const kv = async () => (await mf.getKVNamespace('RESULTS')) as unknown as Kv

async function until<T>(read: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('Cloudflare Queues (Miniflare, real workerd)', () => {
  it('bundles for the edge without the Node-only drivers', () => {
    expect(bundle).not.toContain('BullMQ')
    expect(bundle).not.toContain('maxRetriesPerRequest')
  })

  it('dispatches from a request and runs the job in the queue consumer', async () => {
    const res = await mf.dispatchFetch('http://localhost/dispatch/record/a1', { method: 'POST' })
    expect(await res.text()).toBe('queued')
    const results = await kv()
    expect(await until(() => results.get('done:a1'))).toBe('1')
  })

  it('retries with the job’s backoff as new messages, beyond the queue’s max_retries', async () => {
    await mf.dispatchFetch('http://localhost/dispatch/flaky/f1', { method: 'POST' })
    const results = await kv()
    expect(await until(() => results.get('done:f1'), 20_000)).toBe('3')
    const first = Number(await results.get('attempt:f1:1'))
    const second = Number(await results.get('attempt:f1:2'))
    expect(second - first).toBeGreaterThanOrEqual(900) // backoff: 1s
  }, 30_000)
})

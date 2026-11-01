import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { createApp, defineEnv } from '@caldera-js/core'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineJob, dispatch, queueProvider } from '../src/index.js'
import { qstashDriver, qstashReceiver } from '../src/qstash.js'

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const runs: { id: string; attempt: number; at: number }[] = []
const Record = defineJob({ name: 'qs.record', payload: z.object({ id: z.string() }), handle: ({ id }, ctx) => void runs.push({ id, attempt: ctx.attempt, at: Date.now() }) })
const Flaky = defineJob({
  name: 'qs.flaky',
  payload: z.object({ id: z.string() }),
  tries: 3,
  backoff: 1,
  handle: ({ id }, ctx) => {
    runs.push({ id, attempt: ctx.attempt, at: Date.now() })
    if (ctx.attempt < 3) throw new Error('not yet')
  },
})

let qstash: ChildProcess
let server: ServerType
let appUrl: string

beforeAll(async () => {
  // The real QStash protocol, from Upstash's local development server.
  const bin = join(dirname(createRequire(import.meta.url).resolve('@upstash/qstash-cli/package.json')), 'bin/qstash')
  // Besides -port, qstash dev binds -port + 1 and three ephemeral ports it picks itself. Test files
  // start servers in parallel and macOS hands out ports in sequence, so one of those can be taken by
  // another file first: on "address already in use", wait a moment (out of the burst) and try again.
  let credentials: Record<string, string> | undefined
  for (let attempt = 1; !credentials; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 200 + Math.random() * 600))
    const qstashPort = await freePort()
    const child = spawn(bin, ['dev', '-port', String(qstashPort)])
    qstash = child
    credentials = await new Promise<Record<string, string> | undefined>((resolve, reject) => {
      let output = ''
      let errors = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const found = Object.fromEntries([...output.matchAll(/^(QSTASH_\w+)=(\S+)$/gm)].map((m) => [m[1]!, m[2]!]))
        if (found.QSTASH_NEXT_SIGNING_KEY) resolve(found)
      })
      child.stderr!.on('data', (chunk: Buffer) => (errors += chunk.toString()))
      child.once('exit', (code) => {
        // Its fatal errors go to stdout.
        const log = `${output}${errors}`
        if (log.includes('address already in use') && attempt < 10) resolve(undefined)
        else reject(new Error(`qstash dev exited with ${code}: ${log}`))
      })
    })
  }

  const port = await freePort()
  appUrl = `http://127.0.0.1:${port}`
  const app = createApp({
    env: defineEnv({}),
    providers: [
      queueProvider(
        () => ({
          default: 'qstash',
          connections: {
            qstash: {
              driver: 'qstash',
              token: credentials.QSTASH_TOKEN!,
              baseUrl: credentials.QSTASH_URL!,
              url: `${appUrl}/_caldera/queue`,
              currentSigningKey: credentials.QSTASH_CURRENT_SIGNING_KEY!,
              nextSigningKey: credentials.QSTASH_NEXT_SIGNING_KEY!,
            },
          },
        }),
        { drivers: [qstashDriver] },
      ),
    ],
  })
  const http = new Hono()
    .use(app.middleware())
    .route('/', qstashReceiver({ jobs: [Record, Flaky] }))
    .post('/dispatch/:job/:id', async (c) => {
      await dispatch(c.req.param('job') === 'flaky' ? Flaky : Record, { id: c.req.param('id') })
      return c.text('queued')
    })
  server = serve({ fetch: http.fetch, port, hostname: '127.0.0.1' })
}, 60_000)

afterAll(async () => {
  server?.close()
  // Wait for the server to exit (it shuts down gracefully), so no process outlives the tests.
  if (qstash && qstash.exitCode === null) {
    const exited = new Promise((resolve) => qstash.once('exit', resolve))
    qstash.kill('SIGTERM')
    const timer = setTimeout(() => qstash.kill('SIGKILL'), 3000)
    await exited
    clearTimeout(timer)
  }
})

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('QStash (local QStash server, real signatures)', () => {
  it('delivers a dispatched job to the receiver', async () => {
    expect(await (await fetch(`${appUrl}/dispatch/record/r1`, { method: 'POST' })).text()).toBe('queued')
    await until(() => runs.some((r) => r.id === 'r1'))
    expect(runs.find((r) => r.id === 'r1')!.attempt).toBe(1)
  })

  it('retries with the job’s own backoff, published again with a delay', async () => {
    await fetch(`${appUrl}/dispatch/flaky/f1`, { method: 'POST' })
    await until(() => runs.filter((r) => r.id === 'f1').length === 3, 20_000)
    const attempts = runs.filter((r) => r.id === 'f1')
    expect(attempts.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(900)
  }, 30_000)

  it('rejects deliveries without a valid signature', async () => {
    const body = JSON.stringify({ v: 1, id: 'x', job: 'qs.record', queue: 'default', payload: { id: 'forged' }, attempt: 1, maxTries: 1, backoff: [0], timeout: 60, retryUntil: null, dispatchedAt: 0 })
    expect((await fetch(`${appUrl}/_caldera/queue`, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(`${appUrl}/_caldera/queue`, { method: 'POST', body, headers: { 'upstash-signature': 'eyJhbGciOiJIUzI1NiJ9.e30.bad' } })).status).toBe(401)
    expect(runs.some((r) => r.id === 'forged')).toBe(false)
  })
})

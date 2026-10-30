import { AsyncLocalStorage } from 'node:async_hooks'
import { createApp, defineEnv } from '@caldera/core'
import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineJob, dispatch, queueProvider } from '../src/index.js'

const events: string[] = []
const Slow = defineJob({
  name: 'deferred.slow',
  payload: z.object({ n: z.number() }),
  tries: 2,
  handle: async ({ n }, ctx) => {
    if (n === 2 && ctx.attempt === 1) throw new Error('first try fails')
    await new Promise((r) => setTimeout(r, 30))
    events.push(`job ${n} done (attempt ${ctx.attempt})`)
  },
})

function makeHttp() {
  const app = createApp({
    env: defineEnv({}),
    asyncContext: AsyncLocalStorage,
    providers: [queueProvider(() => ({ default: 'deferred', connections: { deferred: { driver: 'deferred' } } }))],
  })
  return new Hono().use(app.middleware()).get('/signup/:n', async (c) => {
    await dispatch(Slow, { n: Number(c.req.param('n')) })
    events.push('responded')
    return c.text('ok')
  })
}

it('runs the job after the response, retrying in place', async () => {
  events.length = 0
  const http = makeHttp()
  expect(await (await http.request('/signup/2')).text()).toBe('ok')
  expect(events).toEqual(['responded'])
  await new Promise((r) => setTimeout(r, 100))
  expect(events).toEqual(['responded', 'job 2 done (attempt 2)'])
})

it('hands the work to the request’s waitUntil on Workers', async () => {
  events.length = 0
  const kept: Promise<unknown>[] = []
  const executionCtx = { waitUntil: (p: Promise<unknown>) => void kept.push(p), passThroughOnException: () => {}, props: {} }
  const res = await makeHttp().request('/signup/1', {}, {}, executionCtx)
  expect(res.status).toBe(200)
  expect(kept).toHaveLength(1)
  await Promise.all(kept)
  expect(events).toEqual(['responded', 'job 1 done (attempt 1)'])
})

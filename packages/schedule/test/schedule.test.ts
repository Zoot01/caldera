import { cacheProvider, createCacheService } from '@caldera-js/cache'
import { createApp, defineEnv } from '@caldera-js/core'
import { createQueue, defineJob, queueProvider } from '@caldera-js/queue'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createScheduler, cronRoutes, defineSchedule, handleScheduled, scheduleProvider } from '../src/index.js'

const ran: string[] = []
afterEach(() => {
  ran.length = 0
})
const Report = defineJob({ name: 'report', payload: z.object({ kind: z.string().default('daily') }), handle: ({ kind }) => void ran.push(kind) })

const at = (iso: string) => new Date(iso)
function setup(schedules: Parameters<typeof createScheduler>[0]['schedules'], environment = 'production') {
  const cache = createCacheService({ default: 'm', stores: { m: { driver: 'memory' } } })
  const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } }, { store: () => cache })
  const fake = queue.fake()
  return { cache, queue, fake, scheduler: createScheduler({ schedules, queue: () => queue, store: () => cache, environment: () => environment }) }
}

describe('defineSchedule', () => {
  it('reads cron in its time zone, and refuses what platforms can’t run', () => {
    const nightly = defineSchedule('reports.nightly', { cron: '0 2 * * *', tz: 'America/New_York', job: Report })
    expect(nightly.isDue(at('2026-11-02T07:00:30Z'))).toBe(true) // 02:00 in New York (EST)
    expect(nightly.isDue(at('2026-11-02T02:00:00Z'))).toBe(false)
    expect(nightly.nextRun(at('2026-11-02T07:00:00Z'))!.toISOString()).toBe('2026-11-03T07:00:00.000Z')
    expect(() => defineSchedule('x', { cron: '*/5 * * * * *', job: Report })).toThrow(/5 fields/)
    expect(() => defineSchedule('x', { cron: '61 * * * *', job: Report })).toThrow(/can't read/)
    // @ts-expect-error wrong payload for the job
    expect(() => defineSchedule('x', { cron: '* * * * *', job: Report, payload: { kind: 1 } })).toThrow()
  })
})

describe('runDue', () => {
  const everyMinute = defineSchedule('tick', { cron: '* * * * *', job: Report, payload: { kind: 'tick' } })
  const hourly = defineSchedule('hourly', { cron: '0 * * * *', job: Report, payload: { kind: 'hourly' } })

  it('dispatches what is due this minute, once per minute', async () => {
    const { scheduler, fake } = setup([everyMinute, hourly])
    const first = await scheduler.runDue(at('2026-11-02T10:00:05Z'))
    expect(first.minute).toBe('2026-11-02T10:00:00.000Z')
    expect(first.results.map((r) => `${r.name}:${r.status}`)).toEqual(['tick:dispatched', 'hourly:dispatched'])
    // A second tick in the same minute (timer drift) does nothing.
    expect((await scheduler.runDue(at('2026-11-02T10:00:40Z'))).results.map((r) => r.reason)).toEqual(['already-ran', 'already-ran'])
    expect((await scheduler.runDue(at('2026-11-02T10:01:00Z'))).results.map((r) => r.name)).toEqual(['tick'])
    await fake.drain()
    expect(ran).toEqual(['tick', 'hourly', 'tick'])
  })

  it('forgets what ran this minute after reset() (tests, between cases)', async () => {
    const { scheduler } = setup([everyMinute])
    await scheduler.runDue(at('2026-11-02T10:00:05Z'))
    expect((await scheduler.runDue(at('2026-11-02T10:00:40Z'))).results[0]!.reason).toBe('already-ran')
    scheduler.reset()
    expect((await scheduler.runDue(at('2026-11-02T10:00:40Z'))).results[0]!.status).toBe('dispatched')
  })

  it('respects environments', async () => {
    const prodOnly = defineSchedule('prod', { cron: '* * * * *', job: Report, environments: ['production'] })
    expect((await setup([prodOnly], 'local').scheduler.runDue(at('2026-11-02T10:00:00Z'))).results).toEqual([{ name: 'prod', status: 'skipped', reason: 'environment' }])
  })

  it('onOneServer: two servers ticking the same minute dispatch once', async () => {
    const once = defineSchedule('once', { cron: '* * * * *', job: Report, onOneServer: true })
    const { cache, queue, fake } = setup([once])
    const serverA = createScheduler({ schedules: [once], queue: () => queue, store: () => cache })
    const serverB = createScheduler({ schedules: [once], queue: () => queue, store: () => cache })
    const results = await Promise.all([serverA.runDue(at('2026-11-02T10:00:00Z')), serverB.runDue(at('2026-11-02T10:00:20Z'))])
    expect(results.flatMap((r) => r.results.map((x) => x.status)).sort()).toEqual(['dispatched', 'skipped'])
    expect(fake.dispatched()).toHaveLength(1)
  })

  it('onOneServer needs a shared store with locks', async () => {
    const once = defineSchedule('once', { cron: '* * * * *', job: Report, onOneServer: true })
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
    await expect(createScheduler({ schedules: [once], queue: () => queue }).runDue(at('2026-11-02T10:00:00Z'))).rejects.toThrow(/needs a shared store with locks/)
  })

  it('withoutOverlapping skips while the previous run’s job is still queued or running', async () => {
    const sync = defineSchedule('sync', { cron: '* * * * *', job: Report, withoutOverlapping: { for: '10m' } })
    const { cache } = setup([])
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } }, { store: () => cache })
    const scheduler = createScheduler({ schedules: [sync], queue: () => queue, store: () => cache })
    expect((await scheduler.runDue(at('2026-11-02T10:00:00Z'))).results[0]!.status).toBe('dispatched')
    expect((await scheduler.runDue(at('2026-11-02T10:01:00Z'))).results[0]).toMatchObject({ status: 'skipped', reason: 'overlapping' })
    // Once the job has run, the next run goes ahead.
    await (queue.manager.use('memory') as unknown as { drain(r: unknown): Promise<unknown> }).drain({ process: (e: never) => queue.process(e) })
    expect((await scheduler.runDue(at('2026-11-02T10:02:00Z'))).results[0]!.status).toBe('dispatched')
  })

  it('run(name) runs one schedule whatever its cron says, and lists next runs', async () => {
    const nightly = defineSchedule('nightly', { cron: '0 2 * * *', job: Report })
    const { scheduler, fake } = setup([nightly])
    expect(await scheduler.run('nightly', at('2026-11-02T10:17:00Z'))).toMatchObject({ status: 'dispatched' })
    expect(fake.dispatched()).toHaveLength(1)
    await expect(scheduler.run('missing')).rejects.toThrow(/No schedule named "missing"/)
    expect(scheduler.list(at('2026-11-02T10:17:00Z'))).toEqual([
      expect.objectContaining({ name: 'nightly', cron: '0 2 * * *', tz: 'UTC', job: 'report', next: '2026-11-03T02:00:00.000Z' }),
    ])
  })
})

describe('runners', () => {
  const nightly = defineSchedule('nightly', { cron: '0 2 * * *', job: Report, payload: { kind: 'nightly' } })
  const makeApp = () =>
    createApp({
      env: defineEnv({}),
      providers: [
        cacheProvider(() => ({ default: 'm', stores: { m: { driver: 'memory' } } })),
        queueProvider(() => ({ default: 'sync', connections: { sync: { driver: 'sync' } } })),
        scheduleProvider({ schedules: [nightly] }),
      ],
    })

  it('Cloudflare: handleScheduled runs what is due at the trigger’s time', async () => {
    const app = makeApp()
    const result = await handleScheduled(app, { scheduledTime: Date.parse('2026-11-02T02:00:00Z') }, {})
    expect(result.results).toEqual([expect.objectContaining({ name: 'nightly', status: 'dispatched' })])
    expect(ran).toEqual(['nightly'])
  })

  it('HTTP cron: needs the secret, refuses everything without one, runs a named schedule', async () => {
    const app = makeApp()
    const http = (secret: string | undefined) => new Hono().use(app.middleware()).route('/', cronRoutes({ secret: () => secret }))
    expect((await http(undefined).request('/_caldera/cron')).status).toBe(503)
    expect((await http('s3cret').request('/_caldera/cron', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const res = await http('s3cret').request('/_caldera/cron?schedule=nightly', { headers: { authorization: 'Bearer s3cret' } })
    expect(await res.json()).toMatchObject({ results: [{ name: 'nightly', status: 'dispatched' }] })
    expect(ran).toEqual(['nightly'])
  })
})

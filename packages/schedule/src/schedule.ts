import { CalderaError, defineProvider, parseDuration, type Duration } from '@caldera/core'
import type { AnyJob, PayloadOf, Queue, QueueStore } from '@caldera/queue'
import { Cron } from 'croner'

export interface ScheduleOptions<J extends AnyJob> {
  /** Standard 5-field cron, e.g. `0 2 * * *` (02:00 every day). */
  cron: string
  /** IANA time zone the cron is read in. Default UTC. */
  tz?: string
  /** Scheduled work always runs as a job, so it stays within serverless time limits. */
  job: J
  payload?: PayloadOf<J>
  /** Skip a run while the previous run's job is still queued or running. `for`: how long that guard lasts if a job dies. */
  withoutOverlapping?: boolean | { for: Duration }
  /**
   * Dispatch once per run even when several servers tick (needs a store with locks, e.g. Redis).
   * Platform crons (Cloudflare, Vercel) fire once already.
   */
  onOneServer?: boolean
  /** Only in these environments (CALDERA_ENV, then NODE_ENV, then `local`). Default: all. */
  environments?: readonly string[]
  description?: string
}

export interface ScheduleDefinition<J extends AnyJob = AnyJob> {
  readonly kind: 'caldera.schedule'
  readonly name: string
  readonly cron: string
  readonly tz: string
  readonly job: J
  readonly payload: unknown
  /** Seconds the overlap guard lasts, or null. */
  readonly withoutOverlapping: number | null
  readonly onOneServer: boolean
  readonly environments: readonly string[] | null
  readonly description: string | null
  /** True when `date`'s minute matches the cron. */
  isDue(date: Date): boolean
  /** The next run strictly after `after`. */
  nextRun(after?: Date): Date | null
}
export type AnySchedule = ScheduleDefinition<any>

/** A cron schedule that dispatches a job. Export it from a file in `src/schedules`; `caldera generate` registers it. */
export function defineSchedule<J extends AnyJob>(name: string, options: ScheduleOptions<J>): ScheduleDefinition<J> {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(name)) throw new CalderaError('schedule_name_invalid', `Schedule name "${name}" should be a stable id like "reports.daily".`)
  if (options.cron.trim().split(/\s+/).length !== 5) {
    throw new CalderaError('schedule_cron_invalid', `Schedule "${name}": "${options.cron}" should have 5 fields (minute hour day month weekday); platform crons have no seconds.`)
  }
  const tz = options.tz ?? 'UTC'
  let cron: Cron
  try {
    cron = new Cron(options.cron, { timezone: tz, paused: true })
  } catch (error) {
    throw new CalderaError('schedule_cron_invalid', `Schedule "${name}": can't read "${options.cron}" in ${tz} (${(error as Error).message}).`)
  }
  options.job.payload.parse(options.payload ?? {})
  const overlap = options.withoutOverlapping
  return {
    kind: 'caldera.schedule',
    name,
    cron: options.cron,
    tz,
    job: options.job,
    payload: options.payload ?? {},
    withoutOverlapping: overlap === undefined || overlap === false ? null : overlap === true ? 86_400 : parseDuration(overlap.for),
    onOneServer: options.onOneServer ?? false,
    environments: options.environments ?? null,
    description: options.description ?? null,
    isDue: (date) => cron.match(startOfMinute(date)),
    nextRun: (after = new Date()) => cron.nextRun(after),
  }
}

export interface RunResult {
  name: string
  status: 'dispatched' | 'skipped'
  reason?: 'environment' | 'already-ran' | 'overlapping'
  jobId?: string
}

export interface Scheduler {
  readonly schedules: readonly AnySchedule[]
  /** Dispatches every schedule due in `now`'s minute. Call it once a minute; extra calls in the same minute do nothing. */
  runDue(now?: Date): Promise<{ minute: string; results: RunResult[] }>
  /** Runs one schedule now, whatever its cron says (a platform cron already decided the time). */
  run(name: string, now?: Date): Promise<RunResult>
  /** Every schedule with its next run, for `caldera schedule:list`. */
  list(now?: Date): { name: string; cron: string; tz: string; job: string; next: string | null; onOneServer: boolean; withoutOverlapping: number | null; environments: readonly string[] | null; description: string | null }[]
}

export function createScheduler(options: {
  schedules: readonly AnySchedule[]
  queue: () => Queue
  /** Holds onOneServer keys (and the queue's overlap guards). Default: the queue's store. */
  store?: () => QueueStore | undefined
  environment?: () => string
}): Scheduler {
  const byName = new Map<string, AnySchedule>()
  for (const schedule of options.schedules) {
    if (byName.has(schedule.name)) throw new CalderaError('schedule_duplicate', `Two schedules are named "${schedule.name}".`)
    byName.set(schedule.name, schedule)
  }
  const environment = options.environment ?? defaultEnvironment
  // Ticks in the same process share this, so a second tick in one minute (timer drift) is a no-op
  // even without a shared store.
  const ranThisProcess = new Set<string>()

  const dispatchOne = async (schedule: AnySchedule, minute: string): Promise<RunResult> => {
    if (schedule.environments && !schedule.environments.includes(environment())) return { name: schedule.name, status: 'skipped', reason: 'environment' }
    const marker = `${schedule.name}@${minute}`
    if (ranThisProcess.has(marker)) return { name: schedule.name, status: 'skipped', reason: 'already-ran' }
    if (schedule.onOneServer) {
      const store = options.store?.()
      if (!store?.capabilities.locks) {
        throw new CalderaError('schedule_needs_locks', `Schedule "${schedule.name}" is onOneServer, which needs a shared store with locks (Redis): add cacheProvider() with a redis store.`)
      }
      if (!(await store.add(`schedule:${marker}`, 1, 120))) return { name: schedule.name, status: 'skipped', reason: 'already-ran' }
    }
    ranThisProcess.add(marker)
    const result = await options.queue().dispatch(schedule.job, schedule.payload as never, {
      ...(schedule.withoutOverlapping !== null ? { unique: { key: `schedule:${schedule.name}`, for: schedule.withoutOverlapping } } : {}),
    })
    if (!result.dispatched) return { name: schedule.name, status: 'skipped', reason: 'overlapping' }
    return { name: schedule.name, status: 'dispatched', jobId: result.id }
  }

  return {
    schedules: options.schedules,
    async runDue(now = new Date()) {
      const minute = startOfMinute(now).toISOString()
      const results: RunResult[] = []
      for (const schedule of options.schedules) {
        if (schedule.isDue(now)) results.push(await dispatchOne(schedule, minute))
      }
      return { minute, results }
    },
    async run(name, now = new Date()) {
      const schedule = byName.get(name)
      if (!schedule) throw new CalderaError('schedule_missing', `No schedule named "${name}". Schedules: ${[...byName.keys()].join(', ') || 'none'}.`)
      return dispatchOne(schedule, startOfMinute(now).toISOString())
    },
    list: (now = new Date()) =>
      options.schedules.map((s) => ({
        name: s.name,
        cron: s.cron,
        tz: s.tz,
        job: s.job.name,
        next: s.nextRun(now)?.toISOString() ?? null,
        onOneServer: s.onOneServer,
        withoutOverlapping: s.withoutOverlapping,
        environments: s.environments,
        description: s.description,
      })),
  }
}

function startOfMinute(date: Date): Date {
  const copy = new Date(date)
  copy.setSeconds(0, 0)
  return copy
}

function defaultEnvironment(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  return env.CALDERA_ENV || env.NODE_ENV || 'local'
}

/**
 * Registers `scheduler` with your schedules: `scheduleProvider({ schedules })`, with `schedules` from
 * `.caldera/schedules.gen.ts` (generated from `src/schedules`). Needs `queueProvider()`.
 */
export function scheduleProvider(options: { schedules: readonly AnySchedule[] }) {
  // The app's services are captured at boot; until then (and if there's no queue) dispatching explains what's missing.
  let services: { queue?: Queue; cache?: QueueStore } = {}
  return defineProvider({
    name: 'schedule',
    register: () => ({
      scheduler: createScheduler({
        schedules: options.schedules,
        queue: () => {
          const queue = services.queue ?? defaultQueueFromGlobal()
          if (!queue) throw new CalderaError('no_queue', 'Schedules dispatch jobs: add queueProvider() to the app.')
          return queue
        },
        store: () => services.cache,
      }),
    }),
    boot: (app) => {
      services = app.services as never
    },
  })
}

function defaultQueueFromGlobal(): Queue | undefined {
  return (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.queue.default')] as Queue | undefined
}

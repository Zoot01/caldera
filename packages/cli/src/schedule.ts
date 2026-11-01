import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CalderaError } from '@caldera-js/core'
import { loadApp, projectEnv, shareMailOutbox } from './describe.js'
import { CONVENTIONS, exportsOfKind, scheduleFiles, type Project } from './project.js'

/** The parts of a schedule definition the CLI reads, so it doesn't depend on @caldera-js/schedule. */
export interface ScheduleLike {
  name: string
  cron: string
  tz: string
  job: { name: string }
  onOneServer: boolean
  withoutOverlapping: number | null
  environments: readonly string[] | null
  description: string | null
  nextRun(after?: Date): Date | null
}

interface SchedulerLike {
  runDue(now?: Date): Promise<{ minute: string; results: { name: string; status: string; reason?: string; jobId?: string }[] }>
  run(name: string): Promise<{ name: string; status: string; reason?: string; jobId?: string }>
}

export async function loadSchedules(project: Project): Promise<{ file: string; exportName: string; schedule: ScheduleLike }[]> {
  const found = []
  for (const file of scheduleFiles(project)) {
    for (const { exportName, value } of exportsOfKind<ScheduleLike>(await project.load(file), 'caldera.schedule')) found.push({ file, exportName, schedule: value })
  }
  return found
}

/** `caldera schedule:list`: every schedule and its next run. Reads the definitions only; nothing boots. */
export async function listSchedules(project: Project, now = new Date()) {
  return {
    schemaVersion: 1 as const,
    schedules: (await loadSchedules(project)).map(({ schedule: s, file }) => ({
      name: s.name,
      cron: s.cron,
      tz: s.tz,
      job: s.job.name,
      next: s.nextRun(now)?.toISOString() ?? null,
      onOneServer: s.onOneServer,
      withoutOverlapping: s.withoutOverlapping,
      environments: s.environments,
      description: s.description,
      file,
    })),
  }
}

/** Boots the app and returns its scheduler (scheduleProvider), for schedule:run and schedule:work. */
export async function bootScheduler(project: Project): Promise<{ scheduler: SchedulerLike; shutdown(): Promise<void> }> {
  const app = await loadApp(project)
  await app.boot({ env: projectEnv(project) })
  const scheduler = (app as unknown as { services: { scheduler?: SchedulerLike } }).services.scheduler
  if (!scheduler) throw new CalderaError('schedule_not_configured', `${CONVENTIONS.app} has no scheduler: add scheduleProvider({ schedules }) to its providers.`)
  return { scheduler, shutdown: () => app.shutdown() }
}

/**
 * `caldera schedule:work`: runs what's due at the start of every minute until stopped, like Laravel's
 * schedule:work. For a server with cron, `* * * * * caldera schedule:run` does the same per minute.
 */
export async function startScheduleWorker(
  project: Project,
  onTick: (result: Awaited<ReturnType<SchedulerLike['runDue']>>) => void,
  options: { now?: () => Date } = {},
): Promise<{ stop(): Promise<void> }> {
  shareMailOutbox(project)
  const { scheduler, shutdown } = await bootScheduler(project)
  const now = options.now ?? (() => new Date())
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()
  let stopped = false
  const schedule = () => {
    const current = now()
    // Just past the next minute boundary, so the tick lands inside the minute it's for.
    const wait = 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()) + 50
    timer = setTimeout(() => {
      running = scheduler
        .runDue(now())
        .then(onTick)
        .catch((error: unknown) => console.error('[caldera] schedule tick failed', error))
        .finally(() => {
          if (!stopped) schedule()
        })
    }, wait)
  }
  // The current minute too, so starting the worker at 10:00:20 still runs what's due at 10:00.
  running = scheduler.runDue(now()).then(onTick)
  await running
  schedule()
  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await running
      await shutdown()
    },
  }
}

export interface SyncResult {
  schemaVersion: 1
  target: 'vercel' | 'cloudflare'
  file: string
  status: 'created' | 'updated' | 'unchanged' | 'stale'
  crons: { path?: string; schedule: string }[]
  warnings: string[]
}

const CRON_PATH = '/_caldera/cron'

/**
 * `caldera schedule:sync`: writes the platform's cron entries from src/schedules. Only Caldera's own
 * entries change; other crons and settings in the file are kept.
 * - vercel: one entry per schedule, calling `/_caldera/cron?schedule=<name>` (Vercel decides the time).
 * - cloudflare: one `* * * * *` trigger; handleScheduled runs whatever is due.
 */
export async function syncSchedules(project: Project, target: 'vercel' | 'cloudflare', options: { check?: boolean } = {}): Promise<SyncResult> {
  const schedules = (await loadSchedules(project)).map((s) => s.schedule)
  const warnings: string[] = []

  if (target === 'vercel') {
    for (const s of schedules) {
      if (s.tz !== 'UTC') warnings.push(`${s.name} runs in ${s.tz}, but Vercel Cron runs in UTC: write its cron in UTC, or it fires at the wrong hour.`)
      if (runsMoreThanDaily(s)) warnings.push(`${s.name} (${s.cron}) runs more than once a day: Vercel's Hobby plan allows daily crons only (Pro allows every minute).`)
    }
    const file = 'vercel.json'
    const current = existsSync(project.path(file)) ? (JSON.parse(readFileSync(project.path(file), 'utf8')) as { crons?: { path: string; schedule: string }[] }) : undefined
    const kept = (current?.crons ?? []).filter((c) => !c.path.startsWith(CRON_PATH))
    const crons = [...kept, ...schedules.map((s) => ({ path: `${CRON_PATH}?schedule=${encodeURIComponent(s.name)}`, schedule: s.cron }))]
    const next = { ...current, crons }
    if (crons.length === 0) delete (next as { crons?: unknown }).crons
    return write(project, file, current === undefined ? undefined : `${JSON.stringify(current, null, 2)}\n`, `${JSON.stringify(next, null, 2)}\n`, { target, crons, warnings, check: options.check })
  }

  const crons = schedules.length ? [{ schedule: '* * * * *' }] : []
  if (existsSync(project.path('wrangler.jsonc'))) {
    throw new CalderaError('wrangler_jsonc', 'wrangler.jsonc has comments Caldera would lose: add `"triggers": { "crons": ["* * * * *"] }` to it yourself.', { file: 'wrangler.jsonc' })
  }
  if (existsSync(project.path('wrangler.json'))) {
    const file = 'wrangler.json'
    const text = readFileSync(project.path(file), 'utf8')
    const current = JSON.parse(text) as { triggers?: { crons?: string[] } }
    const next = { ...current, triggers: { ...current.triggers, crons: crons.map((c) => c.schedule) } }
    return write(project, file, text, `${JSON.stringify(next, null, 2)}\n`, { target, crons, warnings, check: options.check })
  }
  const file = 'wrangler.toml'
  const text = existsSync(project.path(file)) ? readFileSync(project.path(file), 'utf8') : undefined
  if (text === undefined) throw new CalderaError('wrangler_missing', 'No wrangler.toml (or wrangler.json) here: create your Worker config first.', { file })
  const line = `crons = [${crons.map((c) => JSON.stringify(c.schedule)).join(', ')}]`
  const section = /^\[triggers\][^\S\n]*\n((?:(?!^\[)[^\n]*\n?)*)/m
  let next: string
  const match = section.exec(text)
  if (match) {
    const body = match[1]!
    const updated = /^crons\s*=.*$/m.test(body) ? body.replace(/^crons\s*=.*$/m, line) : `${line}\n${body}`
    next = text.slice(0, match.index) + `[triggers]\n${updated}` + text.slice(match.index + match[0].length)
  } else {
    next = `${text.replace(/\n*$/, '\n')}\n[triggers]\n${line}\n`
  }
  return write(project, file, text, next, { target, crons, warnings, check: options.check })
}

function write(project: Project, file: string, current: string | undefined, next: string, rest: { target: 'vercel' | 'cloudflare'; crons: SyncResult['crons']; warnings: string[]; check?: boolean | undefined }): SyncResult {
  const status: SyncResult['status'] = current === next ? 'unchanged' : rest.check ? 'stale' : current === undefined ? 'created' : 'updated'
  if (status === 'created' || status === 'updated') writeFileSync(project.path(file), next)
  return { schemaVersion: 1, target: rest.target, file, status, crons: rest.crons, warnings: rest.warnings }
}

/** True when the cron fires more than once in some day (any minute/hour field that isn't a single value). */
function runsMoreThanDaily(schedule: ScheduleLike): boolean {
  const [minute, hour] = schedule.cron.trim().split(/\s+/)
  return !/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '')
}

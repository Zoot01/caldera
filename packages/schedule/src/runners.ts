import { CalderaError } from '@caldera-js/core'
import { Hono, type Context } from 'hono'
import type { Scheduler } from './schedule.js'

interface BootableApp {
  boot(options?: { env?: Record<string, unknown> }): Promise<unknown>
  readonly services: unknown
}

const schedulerOf = (services: unknown): Scheduler => {
  const scheduler = (services as { scheduler?: Scheduler }).scheduler
  if (!scheduler) throw new CalderaError('schedule_not_configured', 'Add scheduleProvider({ schedules }) to the app.')
  return scheduler
}

/**
 * Cloudflare's cron trigger: `export default { fetch, scheduled: (controller, env) => handleScheduled(app, controller, env) }`
 * with one trigger, `* * * * *` (`caldera schedule:sync --target cloudflare` writes it). Cloudflare limits
 * triggers per account, so one dispatcher runs every schedule that's due.
 */
export async function handleScheduled(app: BootableApp, controller: { scheduledTime: number }, env: Record<string, unknown>) {
  await app.boot({ env })
  return schedulerOf(app.services).runDue(new Date(controller.scheduledTime))
}

/**
 * The route Vercel Cron (or any HTTP cron) calls: GET `/_caldera/cron?schedule=<name>` runs that schedule,
 * GET `/_caldera/cron` runs whatever is due this minute. Requests need `Authorization: Bearer <secret>`
 * (Vercel sends `CRON_SECRET`); with no secret configured every request is refused.
 */
export function cronRoutes(options: { secret: (c: Context) => string | undefined; path?: string }): Hono {
  return new Hono().get(options.path ?? '/_caldera/cron', async (c) => {
    const secret = options.secret(c)
    if (!secret) return c.json({ error: { code: 'cron_secret_missing', message: 'Set CRON_SECRET to enable the cron endpoint.' } }, 503)
    if (!timingSafeEqual(c.req.header('authorization') ?? '', `Bearer ${secret}`)) {
      return c.json({ error: { code: 'unauthenticated', message: 'Not a valid cron request.' } }, 401)
    }
    const scheduler = schedulerOf(c.var)
    const name = c.req.query('schedule')
    return c.json(name ? { results: [await scheduler.run(name)] } : await scheduler.runDue())
  })
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

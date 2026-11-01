import { CalderaError } from '@caldera-js/core'
import { Hono, type MiddlewareHandler } from 'hono'
import { cache } from 'react'
import { executionContext } from './action.js'

export { actionResult, load, parseSetCookie, submit, type ActionResult, type LoadOptions, type ParsedCookie, type SubmitOptions } from './action.js'

/** The parts of a Caldera app the adapter uses (structural, so any app's own @caldera-js/core copy fits). */
interface AppLike<S = Record<string, unknown>> {
  readonly state: string
  readonly services: S
  boot(options?: { env?: Record<string, unknown> }): Promise<unknown>
  middleware(): MiddlewareHandler
}
interface FetchApp {
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>
}

type Handler = (request: Request) => Promise<Response>

/**
 * The Hono app as Next.js route handlers, for `app/api/[[...route]]/route.ts`:
 * `export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = handle(http)`. Give `http` the
 * same `basePath('/api')`. Requests rewritten here from other paths (next.config.ts sends
 * `/_caldera/*`) arrive with their original URL, so the base path is added for them. Work queued
 * with `waitUntil` (deferred jobs) runs through Next's `after()`, so it finishes after the response,
 * on Vercel too.
 */
export function handle(http: FetchApp, options: { basePath?: string } = {}): Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD', Handler> {
  const basePath = (options.basePath ?? '/api').replace(/\/$/, '')
  const handler: Handler = async (incoming) => {
    const executionCtx = await executionContext()
    const url = new URL(incoming.url)
    let request = incoming
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      url.pathname = `${basePath}${url.pathname}`
      const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? null : incoming.body
      request = new Request(url, { method: incoming.method, headers: incoming.headers, body, signal: incoming.signal, ...(body ? { duplex: 'half' } : {}) } as RequestInit)
    }
    return http.fetch(request, process.env, executionCtx)
  }
  return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler, OPTIONS: handler, HEAD: handler }
}

/**
 * The app's process-wide services (db, mail, queue, cache, storage…) in Server Components, server
 * actions and route handlers: `const { mail } = await services(app)`. Boots the app on first use
 * with `process.env` (Next has loaded `.env`); later calls share that boot.
 */
export async function services<S>(app: AppLike<S>): Promise<S> {
  if (app.state !== 'booted') await app.boot({ env: process.env })
  return app.services
}

/**
 * This request's per-request services (`i18n` in the visitor's locale, and `user` with
 * `authenticate({ required: false })` from @caldera-js/auth) in a Server Component or server action:
 * `const { i18n, user } = await requestContext(app, authenticate({ required: false }))`.
 * The app's middleware runs on the incoming request's headers, once per render (React `cache`).
 * Read-only: cookies set here (a session write, `setLocale`) aren't sent; change those in a route
 * handler or with Next's `cookies()`.
 */
export const requestContext: <V extends Record<string, unknown> = Record<string, unknown>>(app: AppLike, ...middleware: MiddlewareHandler[]) => Promise<V> = cache(
  async (app: AppLike, ...middleware: MiddlewareHandler[]) => {
    const { headers } = await import('next/headers.js')
    const incoming = await headers()
    const host = incoming.get('x-forwarded-host') ?? incoming.get('host') ?? 'localhost'
    const protocol = incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
    let vars: Record<string, unknown> | undefined
    const probe = new Hono()
    probe.use(app.middleware())
    for (const handler of middleware) probe.use(handler)
    probe.all('*', (c) => {
      vars = { ...(c.var as Record<string, unknown>) }
      return c.body(null, 204)
    })
    probe.onError((error) => {
      throw error
    })
    await probe.fetch(new Request(`${protocol}://${host}/`, { headers: new Headers(incoming) }), process.env)
    if (!vars) throw new CalderaError('request_context_failed', 'The app’s middleware didn’t reach the end (a middleware returned a response early).')
    return vars as never
  },
) as never

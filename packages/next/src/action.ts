/** What a server action gets back from `submit`: errors per field (the first message each), or the route's JSON. */
export interface ActionResult<T = unknown> {
  ok: boolean
  status: number
  data?: T
  /** Validation errors, one message per field, as forms show them. */
  errors?: Record<string, string>
  /** The error's message for anything else that failed (403, 429…). */
  message?: string
}

interface FetchApp {
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Response | Promise<Response>
}

export interface SubmitOptions {
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** The app's base path (`basePath('/api')` in src/http.ts). Default `/api`. */
  basePath?: string
}

// Headers of the browser's request that a route should see as its own; Next's own are left out.
const FORWARDED = ['cookie', 'user-agent', 'accept-language', 'origin', 'referer', 'sec-fetch-site', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-socket-id']

/**
 * Calls one of the app's routes from a server action, as the browser that sent the action: its cookies,
 * address and language. What the route answers becomes Next's: cookies it sets (the session, Better
 * Auth's) are set with `cookies()`, a redirect is Next's `redirect()`, and validation errors come back
 * as `errors` for the form. `export async function login(form) { return submit(http, '/login', form) }`.
 */
export async function submit<T = unknown>(http: FetchApp, path: string, data?: unknown, options: SubmitOptions = {}): Promise<ActionResult<T>> {
  const [{ cookies }, { redirect }] = await Promise.all([import('next/headers.js'), import('next/navigation.js')])
  const { response, origin } = await call(http, options.method ?? 'POST', path, options.basePath, JSON.stringify(data ?? {}))

  const store = await cookies()
  for (const header of response.headers.getSetCookie()) {
    const cookie = parseSetCookie(header)
    if (cookie) store.set(cookie)
  }

  const location = response.headers.get('location')
  if (response.status >= 300 && response.status < 400 && location) redirect(sameOriginPath(location, origin))
  return actionResult<T>(response)
}

export interface LoadOptions {
  /** Default `/api`. */
  basePath?: string
  /** Where guests go (a 401), with `?redirect=` back to this page. Default `/login`. */
  loginUrl?: string
}

/**
 * A page's data in a Server Component, from one of the app's GET routes: `await load<Props>(http,
 * '/settings/security')`. The route runs as the browser's request (its cookies), with its middleware:
 * a redirect it answers is Next's `redirect()`, a 401 sends guests to the login page and back, a 404
 * is Next's `notFound()`. Anything else that fails throws. Rendering never sets cookies, so a route
 * used this way should only read.
 */
export async function load<T = unknown>(http: FetchApp, path: string, options: LoadOptions = {}): Promise<T> {
  const [{ headers }, { notFound, redirect }] = await Promise.all([import('next/headers.js'), import('next/navigation.js')])
  const { response, origin } = await call(http, 'GET', path, options.basePath)
  const location = response.headers.get('location')
  if (response.status >= 300 && response.status < 400 && location) redirect(sameOriginPath(location, origin))
  if (response.status === 401) {
    const page = (await headers()).get('x-pathname') ?? path
    redirect(`${options.loginUrl ?? '/login'}?redirect=${encodeURIComponent(page)}`)
  }
  if (response.status === 404) notFound()
  if (!response.ok) {
    const result = await actionResult(response)
    throw new Error(`GET ${path} answered ${response.status}: ${result.message}`)
  }
  return (await response.json()) as T
}

/** Runs a route of the app in-process, as the browser's request. */
async function call(http: FetchApp, method: string, path: string, base: string | undefined, body?: string) {
  const { headers } = await import('next/headers.js')
  const incoming = await headers()
  const basePath = (base ?? '/api').replace(/\/$/, '')
  const host = incoming.get('x-forwarded-host') ?? incoming.get('host') ?? 'localhost'
  const protocol = incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  const forwarded = new Headers({ accept: 'application/json', host, ...(body === undefined ? {} : { 'content-type': 'application/json' }) })
  for (const name of FORWARDED) {
    const value = incoming.get(name)
    if (value !== null) forwarded.set(name, value)
  }
  const origin = `${protocol}://${host}`
  const request = new Request(`${origin}${basePath}${path}`, { method, headers: forwarded, ...(body === undefined ? {} : { body }) })
  return { response: await http.fetch(request, process.env, await executionContext()), origin }
}

/** The route's answer as an `ActionResult` (redirects and cookies are `submit`'s). */
export async function actionResult<T>(response: Response): Promise<ActionResult<T>> {
  const json = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json().catch(() => undefined) : undefined
  if (response.ok) return { ok: true, status: response.status, ...(json === undefined ? {} : { data: json as T }) }
  const error = (json as { error?: { message?: string; fields?: Record<string, string[]> } } | undefined)?.error
  const errors = error?.fields ? Object.fromEntries(Object.entries(error.fields).map(([field, messages]) => [field, messages[0] ?? ''])) : undefined
  return { ok: false, status: response.status, ...(errors ? { errors } : {}), message: error?.message ?? response.statusText }
}

/** `waitUntil` for work queued during the route (deferred jobs): Next's `after()`. */
export async function executionContext() {
  const { after } = await import('next/server.js')
  return { waitUntil: (promise: Promise<unknown>) => after(() => promise), passThroughOnException() {}, props: {} }
}

export interface ParsedCookie {
  name: string
  value: string
  path?: string
  domain?: string
  expires?: Date
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  partitioned?: boolean
}

/** One `Set-Cookie` header as the options `cookies().set()` takes. */
export function parseSetCookie(header: string): ParsedCookie | undefined {
  const [pair, ...attributes] = header.split(';')
  const separator = pair!.indexOf('=')
  if (separator < 1) return undefined
  const cookie: ParsedCookie = { name: pair!.slice(0, separator).trim(), value: decode(pair!.slice(separator + 1).trim()) }
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=')
    const key = rawKey!.trim().toLowerCase()
    const value = rest.join('=').trim()
    if (key === 'path') cookie.path = value
    else if (key === 'domain') cookie.domain = value
    else if (key === 'expires') cookie.expires = new Date(value)
    else if (key === 'max-age') cookie.maxAge = Number(value)
    else if (key === 'httponly') cookie.httpOnly = true
    else if (key === 'secure') cookie.secure = true
    else if (key === 'partitioned') cookie.partitioned = true
    else if (key === 'samesite') cookie.sameSite = value.toLowerCase() as ParsedCookie['sameSite']
  }
  return cookie
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A redirect to this site as a path; anywhere else as it is. */
function sameOriginPath(location: string, origin: string): string {
  const url = new URL(location, origin)
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.toString()
}

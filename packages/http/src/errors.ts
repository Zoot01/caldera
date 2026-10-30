import { CalderaError } from '@caldera/core'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { back, INTENDED_KEY, redirect } from './redirect.js'
import { isSessionStarted, sessionOf } from './session.js'

/** The one error shape every Caldera HTTP response uses. Clients can type their failure branch with it. */
export interface ErrorBody {
  error: {
    code: 'validation_failed' | 'not_found' | 'forbidden' | 'unauthenticated' | 'bad_request' | 'csrf_failed' | 'rate_limited' | 'server_error' | (string & {})
    message: string
    status: number
    fields?: Record<string, string[]>
    /** Seconds until a refused (429) request may be retried. */
    retryAfter?: number
    requestId: string
    debug?: { name: string; stack?: string }
  }
}

/** An error that maps to an HTTP response. Its message is safe to show to clients. */
export class HttpError extends CalderaError {
  readonly status: ContentfulStatusCode
  readonly fields: Record<string, string[]> | undefined
  /** Headers the error response carries, e.g. `Retry-After`. */
  readonly headers: Record<string, string> = {}

  constructor(status: ContentfulStatusCode, code: string, message: string, fields?: Record<string, string[]>) {
    super(code, message, fields ? { fields } : undefined)
    this.status = status
    this.fields = fields
  }
}

/** 429. `@caldera/cache` limiters throw their own `rate_limited` error, which maps to this. */
export class TooManyRequestsError extends HttpError {
  readonly retryAfter: number

  constructor(message = 'Too many requests. Try again later.', retryAfter = 60, headers: Record<string, string> = {}) {
    super(429, 'rate_limited', message)
    this.retryAfter = retryAfter
    Object.assign(this.headers, { 'retry-after': String(retryAfter), ...headers })
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'The request could not be understood.') {
    super(400, 'bad_request', message)
  }
}

export class UnauthenticatedError extends HttpError {
  constructor(message = 'You need to sign in to do that.') {
    super(401, 'unauthenticated', message)
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'You are not allowed to do that.', code = 'forbidden') {
    super(403, code, message)
  }
}

/**
 * `what` names the missing thing for logs only: the client message is always the same,
 * so a 404 never reveals whether a record exists.
 */
export class NotFoundError extends HttpError {
  readonly what: string | undefined

  constructor(what?: string) {
    super(404, 'not_found', 'Not found.')
    this.what = what
  }
}

export class ValidationError extends HttpError {
  declare readonly fields: Record<string, string[]>

  constructor(fields: Record<string, string[]>, message = 'The given data was invalid.') {
    super(422, 'validation_failed', message, fields)
  }

  static fromZod(error: ZodError): ValidationError {
    const fields: Record<string, string[]> = {}
    for (const issue of error.issues) {
      const key = issue.path.length ? issue.path.map(String).join('.') : '_'
      ;(fields[key] ??= []).push(issue.message)
    }
    return new ValidationError(fields)
  }
}

export interface ErrorHandlerOptions {
  /** Include error names and stacks in responses. Never enable in production. */
  debug?: boolean
  /** Called for unexpected (5xx) errors. Defaults to `console.error`. */
  report?: (error: unknown, c: Context) => void
  /**
   * Where signed-out page visits go, e.g. `'/login'`. Browsers asking for a page (and Inertia
   * visits) are redirected, remembering the page for `intended(c)`; API requests keep the 401.
   */
  loginUrl?: string | ((c: Context) => string)
}

/** The messages Caldera's own errors use; with @caldera/i18n these come from `errors.<code>` instead. */
const DEFAULT_MESSAGES: Record<string, string> = {
  validation_failed: 'The given data was invalid.',
  not_found: 'Not found.',
  unauthenticated: 'You need to sign in to do that.',
  forbidden: 'You are not allowed to do that.',
  rate_limited: 'Too many requests. Try again later.',
  bad_request: 'The request could not be understood.',
  server_error: 'Something went wrong.',
}

/** A default message in the request's locale. Messages an app wrote itself are left as they are. */
function localized(c: Context, code: string, message: string): string {
  if (DEFAULT_MESSAGES[code] !== message) return message
  const i18n = (c.var as { i18n?: { errorMessage?: (code: string) => string | undefined } }).i18n
  try {
    return i18n?.errorMessage?.(code) ?? message
  } catch {
    return message
  }
}

export function requestIdOf(c: Context): string {
  const fromVar = (c.var as { requestId?: unknown }).requestId
  if (typeof fromVar === 'string') return fromVar
  return c.req.header('x-request-id') ?? crypto.randomUUID()
}

/** Turns any thrown value into the standard envelope. Use as `app.onError(errorHandler())`. */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  const report = options.report ?? ((error: unknown) => console.error(error))

  return async (error, c) => {
    const known = toHttpError(error)
    if (known instanceof ValidationError && redirectsOnValidation(c)) return validationRedirect(c, known)
    // A refused form post on an Inertia page shows on the form, like a validation error.
    if (known instanceof TooManyRequestsError && c.req.method !== 'GET' && redirectsOnValidation(c)) {
      const response = back(c).withErrors({ _: [known.message] }, c.req.header('x-inertia-error-bag') || undefined)
      for (const [name, value] of Object.entries(known.headers)) response.headers.set(name, value)
      return response
    }
    if (known?.status === 401 && options.loginUrl && isPageVisit(c)) {
      const login = typeof options.loginUrl === 'function' ? options.loginUrl(c) : options.loginUrl
      // The login page itself must never bounce to itself.
      if (new URL(login, c.req.url).pathname !== c.req.path) return loginRedirect(c, login)
    }
    if (!known) {
      report(error, c)
      devReport(error, c)
    }
    const status = known?.status ?? 500
    const code = known?.code ?? 'server_error'
    const body: ErrorBody = {
      error: {
        code,
        message: localized(c, code, known?.message ?? DEFAULT_MESSAGES.server_error!),
        status,
        ...(known?.fields ? { fields: known.fields } : {}),
        ...(known instanceof TooManyRequestsError ? { retryAfter: known.retryAfter } : {}),
        requestId: requestIdOf(c),
        ...(options.debug && error instanceof Error ? { debug: { name: error.name, stack: error.stack } } : {}),
      },
    }
    const response = c.json(body, status)
    for (const [name, value] of Object.entries(known?.headers ?? {})) response.headers.set(name, value)
    if (error instanceof HTTPException) {
      // Keep headers an HTTPException carried, e.g. WWW-Authenticate.
      const original = error.getResponse()
      original.headers.forEach((value, key) => {
        if (key !== 'content-type' && key !== 'content-length') response.headers.set(key, value)
      })
    }
    return response
  }
}

/** Under `caldera dev`, unexpected errors are also recorded for its MCP server (`last_errors`). */
function devReport(error: unknown, c: Context) {
  const hook = (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.dev.reportError')]
  if (typeof hook !== 'function') return
  const e = error instanceof Error ? error : new Error(String(error))
  hook({ method: c.req.method, path: new URL(c.req.url).pathname, status: 500, name: e.name, message: e.message, stack: e.stack, requestId: requestIdOf(c) })
}

/** A browser asking for a page (or an Inertia visit), as opposed to an API client. */
function isPageVisit(c: Context): boolean {
  return c.req.header('x-inertia') === 'true' || (c.req.header('accept') ?? '').includes('text/html')
}

function loginRedirect(c: Context, login: string): Response {
  // Only GETs are worth returning to: replaying a form post after sign-in would be surprising.
  if (c.req.method === 'GET' && isSessionStarted(c)) {
    const url = new URL(c.req.url)
    sessionOf(c).put(INTENDED_KEY, url.pathname + url.search)
  }
  return redirect(c, login)
}

/**
 * Browsers get their errors on the page they came from: Inertia visits always, and plain HTML form
 * posts when there's a session to carry them. API clients (JSON in or out) get the envelope.
 */
function redirectsOnValidation(c: Context): boolean {
  if (!isSessionStarted(c)) return false
  if (c.req.header('x-inertia')) return true
  const type = c.req.header('content-type') ?? ''
  const isForm = type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')
  return isForm && !(c.req.header('accept') ?? '').includes('application/json')
}

async function validationRedirect(c: Context, error: ValidationError): Promise<Response> {
  const response = back(c).withErrors(error.fields, c.req.header('x-inertia-error-bag') || undefined)
  // Inertia keeps form state in the browser; plain forms need their input back (minus passwords).
  if (!c.req.header('x-inertia')) {
    const input = await c.req.parseBody({ all: true }).catch(() => ({}))
    sessionOf(c).flashInput(input as Record<string, unknown>)
  }
  return response
}

/** Use as `app.notFound(notFoundHandler())` so unmatched routes use the envelope too. */
export function notFoundHandler(): NotFoundHandler {
  return (c) => {
    const body: ErrorBody = { error: { code: 'not_found', message: localized(c, 'not_found', DEFAULT_MESSAGES.not_found!), status: 404, requestId: requestIdOf(c) } }
    return c.json(body, 404)
  }
}

function toHttpError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error
  // Errors from other Caldera packages, matched by code so http doesn't depend on them.
  // not_found always gets the generic body, so it reveals nothing about the record.
  if (error instanceof CalderaError) {
    if (error.code === 'not_found') return new NotFoundError()
    if (error.code === 'forbidden') return new ForbiddenError(error.message)
    if (error.code === 'unauthenticated') return new UnauthenticatedError(error.message)
    if (error.code === 'rate_limited') {
      const details = (error.details ?? {}) as { retryAfter?: number; headers?: Record<string, string> }
      return new TooManyRequestsError(error.message, details.retryAfter, details.headers)
    }
  }
  if (error instanceof ZodError) return ValidationError.fromZod(error)
  if (error instanceof HTTPException) {
    const status = error.status as ContentfulStatusCode
    const code = status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status < 500 ? 'bad_request' : 'server_error'
    // Hono's own messages (e.g. "Malformed JSON in request body") are safe to show for 4xx.
    return status < 500 ? new HttpError(status, code, error.message || 'Bad request.') : undefined
  }
  return undefined
}

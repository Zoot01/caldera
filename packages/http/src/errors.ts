import { CalderaError } from '@caldera/core'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'

/** The one error shape every Caldera HTTP response uses. Clients can type their failure branch with it. */
export interface ErrorBody {
  error: {
    code: 'validation_failed' | 'not_found' | 'forbidden' | 'unauthenticated' | 'bad_request' | 'csrf_failed' | 'rate_limited' | 'server_error' | (string & {})
    message: string
    status: number
    fields?: Record<string, string[]>
    requestId: string
    debug?: { name: string; stack?: string }
  }
}

/** An error that maps to an HTTP response. Its message is safe to show to clients. */
export class HttpError extends CalderaError {
  readonly status: ContentfulStatusCode
  readonly fields: Record<string, string[]> | undefined

  constructor(status: ContentfulStatusCode, code: string, message: string, fields?: Record<string, string[]>) {
    super(code, message, fields ? { fields } : undefined)
    this.status = status
    this.fields = fields
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
}

export function requestIdOf(c: Context): string {
  const fromVar = (c.var as { requestId?: unknown }).requestId
  if (typeof fromVar === 'string') return fromVar
  return c.req.header('x-request-id') ?? crypto.randomUUID()
}

/** Turns any thrown value into the standard envelope. Use as `app.onError(errorHandler())`. */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  const report = options.report ?? ((error: unknown) => console.error(error))

  return (error, c) => {
    const known = toHttpError(error)
    if (!known) report(error, c)
    const status = known?.status ?? 500
    const body: ErrorBody = {
      error: {
        code: known?.code ?? 'server_error',
        message: known?.message ?? 'Something went wrong.',
        status,
        ...(known?.fields ? { fields: known.fields } : {}),
        requestId: requestIdOf(c),
        ...(options.debug && error instanceof Error ? { debug: { name: error.name, stack: error.stack } } : {}),
      },
    }
    const response = c.json(body, status)
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

/** Use as `app.notFound(notFoundHandler())` so unmatched routes use the envelope too. */
export function notFoundHandler(): NotFoundHandler {
  return (c) => {
    const body: ErrorBody = { error: { code: 'not_found', message: 'Not found.', status: 404, requestId: requestIdOf(c) } }
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

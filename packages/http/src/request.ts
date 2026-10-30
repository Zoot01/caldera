import type { Context, MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'
import { z } from 'zod'
import { ForbiddenError, ValidationError } from './errors.js'

type Schema = z.ZodType

/**
 * Laravel's FormRequest as data: what a route accepts and who may call it.
 * `authorize` runs before the input is parsed; `prepare` reshapes raw input first.
 */
export interface RequestDefinition<
  B extends Schema | undefined = Schema | undefined,
  F extends Schema | undefined = Schema | undefined,
  Q extends Schema | undefined = Schema | undefined,
  P extends Schema | undefined = Schema | undefined,
> {
  readonly kind: 'caldera.request'
  /** JSON body. */
  readonly body?: B
  /** Form body (urlencoded or multipart). */
  readonly form?: F
  readonly query?: Q
  /** Route parameters, e.g. to coerce `:id` to a number. */
  readonly params?: P
  readonly prepare?: (raw: unknown, target: 'json' | 'form' | 'query' | 'param') => unknown
  readonly authorize?: (c: Context) => boolean | Promise<boolean>
}

export type AnyRequest = RequestDefinition<any, any, any, any>

export function defineRequest<
  B extends Schema | undefined = undefined,
  F extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  P extends Schema | undefined = undefined,
>(definition: {
  body?: B
  form?: F
  query?: Q
  params?: P
  prepare?: (raw: unknown, target: 'json' | 'form' | 'query' | 'param') => unknown
  authorize?: (c: Context) => boolean | Promise<boolean>
}): RequestDefinition<B, F, Q, P> {
  return { kind: 'caldera.request', ...definition }
}

// Query and route params arrive as strings; their client-side input types say so.
type StringValues<T> = { [K in keyof T]: string | string[] }
type ParamValues<T> = { [K in keyof T]: string }
type FormValues<T> = { [K in keyof T]: string | File | (string | File)[] }

type Part<S, Key extends string, InShape> = S extends Schema ? { [K in Key]: InShape } : {}

/** The Hono `Input` a request definition produces, so `c.req.valid()` and `hc` clients are typed. */
export type InputOf<R> =
  R extends RequestDefinition<infer B, infer F, infer Q, infer P>
    ? {
        in: Part<B, 'json', B extends Schema ? z.input<B> : never> &
          Part<F, 'form', F extends Schema ? FormValues<z.input<F>> : never> &
          Part<Q, 'query', Q extends Schema ? StringValues<z.input<Q>> : never> &
          Part<P, 'param', P extends Schema ? ParamValues<z.input<P>> : never>
        out: Part<B, 'json', B extends Schema ? z.output<B> : never> &
          Part<F, 'form', F extends Schema ? z.output<F> : never> &
          Part<Q, 'query', Q extends Schema ? z.output<Q> : never> &
          Part<P, 'param', P extends Schema ? z.output<P> : never>
      }
    : {}

export interface NamedHandler {
  name: 'authorize' | 'validate'
  handler: MiddlewareHandler
}

/** The middleware a request definition compiles to. Names let the router order them by priority. */
export function requestMiddleware(request: AnyRequest): NamedHandler[] {
  const handlers: NamedHandler[] = []
  if (request.authorize) {
    const authorize = request.authorize
    handlers.push({
      name: 'authorize',
      handler: async (c, next) => {
        if (!(await authorize(c))) throw new ForbiddenError()
        await next()
      },
    })
  }
  const targets = [
    ['json', request.body],
    ['form', request.form],
    ['query', request.query],
    ['param', request.params],
  ] as const
  for (const [target, schema] of targets) {
    if (!schema) continue
    handlers.push({
      name: 'validate',
      handler: validator(target, (value) => {
        const input = request.prepare ? request.prepare(value, target) : value
        const result = (schema as Schema).safeParse(input)
        if (!result.success) throw ValidationError.fromZod(result.error)
        return result.data as {}
      }) as MiddlewareHandler,
    })
  }
  return handlers
}

/** JSON Schemas of each input, for the route manifest. */
export function requestJsonSchemas(request: AnyRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const toJson = (schema: Schema) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  if (request.body) out.body = toJson(request.body)
  if (request.form) out.form = toJson(request.form)
  if (request.query) out.query = toJson(request.query)
  if (request.params) out.params = toJson(request.params)
  return out
}

import type { MiddlewareHandler } from 'hono'
import { NotFoundError } from './errors.js'
import type { RouteContext } from './routes.js'

/**
 * Anything that can load a row for a route parameter: a Caldera model (via `findByRouteKey`)
 * or a function, for scoped lookups such as "this slug within the current team". The function
 * gets the request's `c`, typed with your app's services:
 * `(id: string, c: RouteContext) => Note.findFirst({ where: { id, userId: c.var.user!.id } })`.
 */
export type Binder = { readonly name?: string; findByRouteKey(value: string): Promise<unknown> } | ((value: string, c: RouteContext) => Promise<unknown>)

export type Bindings = Record<string, Binder>

type Bound<B> = B extends (...args: any[]) => Promise<infer T> ? NonNullable<T> : B extends { findByRouteKey(value: string): Promise<infer T> } ? NonNullable<T> : never

/** What `bind` adds to the handler's Hono env: one typed `c.var` entry per bound parameter. */
export type BindEnv<B> = [keyof B] extends [never] ? {} : { Variables: { [K in keyof B]: Bound<B[K]> } }

/** Route model binding: loads each bound parameter, 404s when missing, and sets `c.var[param]`. */
export function bindingMiddleware(bindings: Bindings, path: string): MiddlewareHandler {
  for (const param of Object.keys(bindings)) {
    if (!new RegExp(`:${param}(?:\\{|\\?|/|$)`).test(path)) {
      throw new Error(`Route "${path}" binds "${param}", but has no :${param} parameter.`)
    }
  }
  return async (c, next) => {
    for (const [param, binder] of Object.entries(bindings)) {
      const value = c.req.param(param)
      const row = value === undefined ? undefined : typeof binder === 'function' ? await binder(value, c as unknown as RouteContext) : await binder.findByRouteKey(value)
      if (row === undefined || row === null) throw new NotFoundError(param)
      c.set(param as never, row as never)
    }
    await next()
  }
}

/** How a binding is described in the route manifest. */
export function describeBindings(bindings: Bindings): Record<string, string> {
  return Object.fromEntries(Object.entries(bindings).map(([param, binder]) => [param, typeof binder === 'function' ? 'custom' : (binder.name ?? 'model')]))
}

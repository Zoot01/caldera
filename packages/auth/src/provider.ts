import { defineProvider } from '@caldera/core'
import type { AnyModel } from '@caldera/db'
import type { Context } from 'hono'
import { createGate, type Gate } from './gate.js'
import type { AbilityOf, AuthUser, GateExtensions, PolicyArgs } from './policy.js'

export interface AuthorizationOptions {
  /** How to find the current user. Defaults to `c.var.user`, which the auth middleware sets. */
  user?: (c: Context) => AuthUser | null
  extend?: (c: Context, base: { user: AuthUser | null }) => GateExtensions
}

/**
 * Adds `c.var.gate`, a gate for the current request's user. The user is read lazily, at the first
 * check, so authentication middleware that runs later in the request has already set it.
 */
export function authorizationProvider(options: AuthorizationOptions = {}) {
  const userOf = options.user ?? ((c: Context) => ((c.var as { user?: AuthUser | null }).user ?? null))
  return defineProvider({
    name: 'authorization',
    request: {
      gate: (c): Gate => createGate({ user: () => userOf(c), ...(options.extend ? { extend: (base) => options.extend!(c, base) } : {}) }),
    },
  })
}

/**
 * Route-level authorization for `@caldera/http`: `authorize: allows(Post, 'update', 'post')` checks
 * the bound `c.var.post` after route model binding. Denials become 401, 403 or 404 responses.
 */
export function allows<M extends AnyModel, const A extends AbilityOf<M>>(
  model: M,
  ability: A,
  ...param: PolicyArgs<M, A> extends [] ? [] : [param: string]
): (c: Context) => Promise<true> {
  return async (c) => {
    const gate = (c.var as { gate?: Gate }).gate
    if (!gate) throw new Error('allows() needs authorizationProvider() in the app (it provides c.var.gate).')
    const row = param[0] === undefined ? [] : [(c.var as Record<string, unknown>)[param[0]]]
    await (gate.authorize as unknown as (m: AnyModel, a: string, ...r: unknown[]) => Promise<void>)(model, ability, ...row)
    return true
  }
}

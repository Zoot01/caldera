import { defineProvider } from '@caldera-js/core'
import type { AnyModel } from '@caldera-js/db'
import type { Context } from 'hono'
import { createGate, type Gate } from './gate.js'
import { registerPolicy, type AbilityOf, type AuthUser, type GateExtensions, type Policy, type PolicyArgs } from './policy.js'

export interface AuthorizationOptions {
  /**
   * Every policy in the app: `policies` from `.caldera/policies.gen.ts`, which `caldera generate`
   * writes from `src/policies`. A policy nothing imports is never registered, and checks against
   * its model are refused.
   */
  policies?: readonly Policy<AnyModel, unknown>[]
  /** How to find the current user. Defaults to `c.var.user`, which the auth middleware sets. */
  user?: (c: Context) => AuthUser | null
  /** Adds fields to `g` in policies, e.g. `organizationGate({ roles })` from `@caldera-js/auth/organization`. */
  extend?: (c: Context, base: { user: AuthUser | null }) => GateExtensions
}

/**
 * Adds `c.var.gate`, a gate for the current request's user. The user is read lazily, at the first
 * check, so authentication middleware that runs later in the request has already set it.
 */
export function authorizationProvider(options: AuthorizationOptions = {}) {
  for (const policy of options.policies ?? []) registerPolicy(policy)
  const userOf = options.user ?? ((c: Context) => ((c.var as { user?: AuthUser | null }).user ?? null))
  return defineProvider({
    name: 'authorization',
    request: {
      gate: (c): Gate => createGate({ user: () => userOf(c), ...(options.extend ? { extend: (base) => options.extend!(c, base) } : {}) }),
    },
  })
}

/**
 * Route-level authorization for `@caldera-js/http`: `authorize: allows(Post, 'update', 'post')` checks
 * the bound `c.var.post` after route model binding. Denials become 401, 403 or 404 responses.
 */
export function allows<M extends AnyModel, const A extends AbilityOf<M>>(
  model: M,
  ability: A,
  ...param: PolicyArgs<M, A> extends [] ? [] : [param: string]
): (c: Context) => Promise<true> {
  const check = async (c: Context): Promise<true> => {
    const gate = (c.var as { gate?: Gate }).gate
    if (!gate) throw new Error('allows() needs authorizationProvider() in the app (it provides c.var.gate).')
    const row = param[0] === undefined ? [] : [(c.var as Record<string, unknown>)[param[0]]]
    await (gate.authorize as unknown as (m: AnyModel, a: string, ...r: unknown[]) => Promise<void>)(model, ability, ...row)
    return true
  }
  // Read by the route manifest, so `caldera route:list` and `caldera abilities` show what guards a route.
  return Object.assign(check, { ability: `${model.name}.${ability}`, param: param[0] ?? null })
}

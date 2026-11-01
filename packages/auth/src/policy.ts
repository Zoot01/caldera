import type { AnyModel, Filter, Row } from '@caldera/db'

/**
 * Apps register their user type and policies here; `caldera generate` writes it:
 * `declare module '@caldera/auth' { interface AuthRegister { user: Row<typeof User> } interface PolicyRegistry { post: typeof PostPolicy } }`
 */
export interface AuthRegister {}
/** Model name → policy. Codegen fills it from `src/policies/*.ts`. */
export interface PolicyRegistry {}
/** Packages add fields to the gate context here, e.g. `org` from the Better Auth integration. */
export interface GateExtensions {}

export type AuthUser = AuthRegister extends { user: infer U } ? U : { id: string }

export interface AuthResponse {
  allowed: boolean
  /** 403 by default; 404 hides that the record exists. */
  status?: 403 | 404
  message?: string
}
export type Decision = boolean | AuthResponse
type Result = Decision | Promise<Decision>

export type GateContext = {
  readonly user: AuthUser | null
  /** Caches a value for the rest of the request, e.g. the user's team ids. */
  memo<T>(key: string, compute: () => T): T
} & GateExtensions

/** Abilities that act on the model as a whole, so they take no row (Laravel's convention). */
type NoRowAbility = 'viewAny' | 'create'
type Reserved = 'before' | 'scope' | 'prefetch'

type AbilityFn<R> = (user: AuthUser, row: R, g: GateContext) => Result
/** Guests are denied unless an ability opts in with `guest: true`. */
type GuestAbility<R> = { guest: true; check: (user: AuthUser | null, row: R, g: GateContext) => Result }
type AbilityEntry<R> = AbilityFn<R> | GuestAbility<R>

type ScopeFn<M extends AnyModel, U> = (user: U, g: GateContext) => Filter<M['~key']> | Promise<Filter<M['~key']>>

type ReservedShape<M extends AnyModel> = {
  /** Runs before every ability: `true` allows, `false` denies, `undefined` continues. */
  before: (user: AuthUser | null) => boolean | undefined
  /** The rows the user may see, as a query filter, so lists are filtered in SQL. `gate.scope(Model)` applies it. */
  scope: ScopeFn<M, AuthUser> | { guest: true; where: ScopeFn<M, AuthUser | null> }
  /** Loads what checks over many rows need, once, before `annotate` evaluates them. */
  prefetch: (user: AuthUser, rows: Row<M>[], g: GateContext) => unknown
}

// Homomorphic over P: the keys are inferred and each value gets its contextual type,
// so `(user, post, g)` need no annotations (measured in prototypes/typecheck).
export type PolicyShape<M extends AnyModel, P> = {
  [A in keyof P]: A extends Reserved ? ReservedShape<M>[A] : AbilityEntry<A extends NoRowAbility ? undefined : Row<M>>
}

export interface Policy<M extends AnyModel, P> {
  readonly kind: 'caldera.policy'
  readonly model: M
  readonly definition: P
}

const policies = new Map<string, Policy<AnyModel, Record<string, unknown>>>()

/** The authorization rules for one model. Keep one per file in `src/policies/`. */
export function definePolicy<M extends AnyModel, P>(model: M, definition: PolicyShape<M, P>): Policy<M, P> {
  const policy: Policy<M, P> = { kind: 'caldera.policy', model, definition: definition as P }
  registerPolicy(policy)
  return policy
}

/** Makes a policy the one checks use for its model (`authorizationProvider({ policies })` does this). */
export function registerPolicy(policy: Policy<AnyModel, unknown>): void {
  policies.set(policy.model.name, policy as never)
}

export function policyFor(model: AnyModel): Policy<AnyModel, Record<string, unknown>> | undefined {
  return policies.get(model.name)
}

export const allow = (): AuthResponse => ({ allowed: true })
export const deny = (message?: string): AuthResponse => ({ allowed: false, status: 403, ...(message ? { message } : {}) })
/** Denies with a 404 indistinguishable from a missing record. */
export const denyAsNotFound = (): AuthResponse => ({ allowed: false, status: 404 })

export type PolicyOf<M extends AnyModel> = M['name'] extends keyof PolicyRegistry ? PolicyRegistry[M['name']] : never
export type AbilityOf<M extends AnyModel> = PolicyOf<M> extends Policy<any, infer P> ? Exclude<keyof P, Reserved> & string : never
export type PolicyArgs<M extends AnyModel, A> = A extends NoRowAbility ? [] : [row: Row<M>]

/** An ability not tied to a model, e.g. `viewBilling`. */
export interface Ability<Args extends unknown[]> {
  readonly kind: 'caldera.ability'
  readonly name: string
  readonly guest: boolean
  readonly check: (user: AuthUser | null, ...args: [...Args, GateContext]) => Result
}

export function defineAbility<Args extends unknown[] = []>(
  name: string,
  check: ((user: AuthUser, ...args: [...Args, GateContext]) => Result) | { guest: true; check: (user: AuthUser | null, ...args: [...Args, GateContext]) => Result },
): Ability<Args> {
  return typeof check === 'function'
    ? { kind: 'caldera.ability', name, guest: false, check: check as Ability<Args>['check'] }
    : { kind: 'caldera.ability', name, guest: true, check: check.check }
}

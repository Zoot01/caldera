import { CalderaError } from '@caldera-js/core'
import type { AnyModel, Filter, Row } from '@caldera-js/db'
import { sql } from 'drizzle-orm'
import {
  policyFor,
  type Ability,
  type AbilityOf,
  type AuthResponse,
  type AuthUser,
  type Decision,
  type GateContext,
  type GateExtensions,
  type PolicyArgs,
} from './policy.js'

/** A denied check. `code` maps to the HTTP envelope: forbidden → 403, not_found → 404, unauthenticated → 401. */
export class AuthorizationError extends CalderaError {
  constructor(code: 'forbidden' | 'not_found' | 'unauthenticated', message: string) {
    super(code, message)
  }
}

export interface Inspection {
  allowed: boolean
  status: 401 | 403 | 404 | 200
  message?: string
  /** Which layer decided, for `abilities.explain` and debugging. */
  source: 'before' | 'policy' | 'ability' | 'guest' | 'missing'
}

export interface Gate {
  readonly user: AuthUser | null
  can<M extends AnyModel, const A extends AbilityOf<M>>(model: M, ability: A, ...args: PolicyArgs<M, A>): Promise<boolean>
  can<Args extends unknown[]>(ability: Ability<Args>, ...args: Args): Promise<boolean>
  inspect<M extends AnyModel, const A extends AbilityOf<M>>(model: M, ability: A, ...args: PolicyArgs<M, A>): Promise<Inspection>
  inspect<Args extends unknown[]>(ability: Ability<Args>, ...args: Args): Promise<Inspection>
  /** Throws `AuthorizationError` when denied. */
  authorize<M extends AnyModel, const A extends AbilityOf<M>>(model: M, ability: A, ...args: PolicyArgs<M, A>): Promise<void>
  authorize<Args extends unknown[]>(ability: Ability<Args>, ...args: Args): Promise<void>
  /**
   * Adds `can: { update: true, … }` to each row, for frontends that should only read booleans.
   * The policy's `prefetch` runs once and every check is memoized, so lists don't cause N+1 queries.
   */
  annotate<M extends AnyModel, R extends Row<M>, const A extends AbilityOf<M>>(
    model: M,
    rows: readonly R[],
    abilities: readonly A[],
  ): Promise<(R & { can: { [K in A]: boolean } })[]>
  /**
   * The policy's `scope` for this user, as a filter: `Post.findMany({ where: await gate.scope(Post) })`.
   * `and` narrows it further. Matches every row when `before` allows, and none when it denies or for guests.
   */
  scope<M extends AnyModel>(model: M, and?: Filter<M['~key']>): Promise<Filter<M['~key']>>
  /** The same checks for another user (a fresh memo). */
  forUser(user: AuthUser | null): Gate
  memo<T>(key: string, compute: () => T): T
}

export interface CreateGateOptions {
  user: AuthUser | null | (() => AuthUser | null)
  /** Adds fields to the context policies receive (see `GateExtensions`). */
  extend?: (base: { user: AuthUser | null; memo: GateContext['memo'] }) => GateExtensions
}

/** A gate for one user, usually one per request (`c.var.gate`). */
export function createGate(options: CreateGateOptions): Gate {
  const memos = new Map<string, unknown>()
  const resolveUser = () => (typeof options.user === 'function' ? (options.user as () => AuthUser | null)() : options.user)
  const memo = <T>(key: string, compute: () => T): T => {
    if (!memos.has(key)) memos.set(key, compute())
    return memos.get(key) as T
  }
  let context: GateContext | undefined
  const gateContext = (): GateContext => {
    if (!context) {
      const user = resolveUser()
      context = { user, memo, ...options.extend?.({ user, memo }) } as GateContext
    }
    return context
  }

  const inspect = async (target: AnyModel | Ability<unknown[]>, ...rest: unknown[]): Promise<Inspection> => {
    const g = gateContext()
    const user = g.user
    if (isAbility(target)) {
      if (!user && !target.guest) return guestDenied()
      return fromDecision(await target.check(user, ...[...rest, g]), 'ability')
    }

    const [ability, row] = rest as [string, Record<string, unknown> | undefined]
    const policy = policyFor(target)?.definition as Record<string, unknown> | undefined
    const entry = policy?.[ability] as Function | { guest: true; check: Function } | undefined
    if (!policy || !entry || ability === 'before' || ability === 'scope' || ability === 'prefetch') {
      return { allowed: false, status: 403, message: `No "${ability}" ability is defined for ${target.name}.`, source: 'missing' }
    }
    const before = (policy.before as ((u: AuthUser | null) => boolean | undefined) | undefined)?.(user)
    if (before !== undefined) return fromDecision(before, 'before')

    const guestAllowed = typeof entry === 'object' && entry.guest
    if (!user && !guestAllowed) return guestDenied()
    const check = typeof entry === 'function' ? entry : entry.check
    const key = `${target.name}:${ability}:${row ? String(row.id ?? JSON.stringify(row)) : '*'}`
    const decision = await memo(key, () => check(user, row, g) as Promise<Decision> | Decision)
    return fromDecision(decision, 'policy')
  }

  const gate: Gate = {
    get user() {
      return gateContext().user
    },
    can: (async (target: never, ...rest: never[]) => (await inspect(target, ...rest)).allowed) as Gate['can'],
    inspect: inspect as Gate['inspect'],
    authorize: (async (target: never, ...rest: never[]) => {
      const result = await inspect(target, ...rest)
      if (result.allowed) return
      if (result.status === 401) throw new AuthorizationError('unauthenticated', result.message ?? 'You need to sign in to do that.')
      if (result.status === 404) throw new AuthorizationError('not_found', 'Not found.')
      throw new AuthorizationError('forbidden', result.message ?? 'You are not allowed to do that.')
    }) as Gate['authorize'],
    async annotate(model, rows, abilities) {
      const g = gateContext()
      const policy = policyFor(model)?.definition as { prefetch?: Function } | undefined
      if (g.user && policy?.prefetch) await policy.prefetch(g.user, rows, g)
      return Promise.all(
        rows.map(async (row) => {
          const entries = await Promise.all(abilities.map(async (ability) => [ability, (await inspect(model, ability, row)).allowed] as const))
          return { ...row, can: Object.fromEntries(entries) }
        }),
      ) as never
    },
    async scope(model, and) {
      const g = gateContext()
      const policy = policyFor(model)?.definition as
        | { before?: (u: AuthUser | null) => boolean | undefined; scope?: Function | { guest: true; where: Function } }
        | undefined
      if (!policy?.scope) {
        throw new CalderaError('no_scope', `The ${model.name} policy has no scope, so gate.scope(${model.name}) can't say which rows the user may see.`)
      }
      const before = policy.before?.(g.user)
      const guestAllowed = typeof policy.scope === 'object' && policy.scope.guest
      const where =
        before === true
          ? {}
          : before === false || (!g.user && !guestAllowed)
            ? { RAW: sql`1 = 0` }
            : await (typeof policy.scope === 'function' ? policy.scope : policy.scope.where)(g.user, g)
      return (and ? { AND: [where, and] } : where) as never
    },
    forUser: (user) => createGate({ ...options, user }),
    memo,
  }
  return gate
}

function isAbility(value: unknown): value is Ability<unknown[]> {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'caldera.ability'
}

function guestDenied(): Inspection {
  return { allowed: false, status: 401, message: 'You need to sign in to do that.', source: 'guest' }
}

function fromDecision(decision: Decision, source: Inspection['source']): Inspection {
  if (decision === true) return { allowed: true, status: 200, source }
  if (decision === false) return { allowed: false, status: 403, source }
  const response = decision as AuthResponse
  return response.allowed
    ? { allowed: true, status: 200, source }
    : { allowed: false, status: response.status ?? 403, ...(response.message ? { message: response.message } : {}), source }
}

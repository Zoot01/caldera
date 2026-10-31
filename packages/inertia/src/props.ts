const PROP = Symbol.for('caldera.inertia.prop')

type Resolver<T> = () => T | Promise<T>

/** A page prop with loading rules. Plain values and functions need no wrapper. */
export type Prop<T> = AlwaysProp<T> | LazyProp<T>

/** `always()`: sent on every load. Fine for any prop. */
export interface AlwaysProp<T> {
  readonly [PROP]: 'always'
  readonly resolve: Resolver<T>
}

/**
 * `defer()` and `optional()`: missing from the first load, so only for props the page marks
 * optional (`stats?: Stats`), which it must render without.
 */
export interface LazyProp<T> {
  readonly [PROP]: 'optional' | 'defer'
  readonly resolve: Resolver<T>
  /** For `defer`: props in the same group load in one request. */
  readonly group?: string
}

/** Sent even when a partial reload didn't ask for it. */
export function always<T>(value: T | Resolver<T>): AlwaysProp<T> {
  return { [PROP]: 'always', resolve: toResolver(value) }
}

/** Never on the first load; only when a partial reload asks for it (`router.reload({ only: ['x'] })`). */
export function optional<T>(resolve: Resolver<T>): LazyProp<T> {
  return { [PROP]: 'optional', resolve }
}

/**
 * Left out of the first load, then fetched by the client right after the page renders, so slow
 * data doesn't hold up the page. Props in the same `group` arrive in one request.
 */
export function defer<T>(resolve: Resolver<T>, group = 'default'): LazyProp<T> {
  return { [PROP]: 'defer', resolve, group }
}

export function isProp(value: unknown): value is Prop<unknown> {
  return typeof value === 'object' && value !== null && PROP in value
}

export function propKind(value: Prop<unknown>): Prop<unknown>[typeof PROP] {
  return value[PROP]
}

/**
 * What `c.render` accepts for a prop of type `T`: the value, a function that computes it (only
 * called when the prop is sent), or one of the wrappers above (`defer`/`optional` only when the
 * prop may be missing, i.e. `T` includes undefined).
 */
export type PropInput<T> = T | Resolver<T> | AlwaysProp<T> | (undefined extends T ? LazyProp<Exclude<T, undefined>> : never)

export type PropsInput<P> = { [K in keyof P]: PropInput<P[K]> }

function toResolver<T>(value: T | Resolver<T>): Resolver<T> {
  return typeof value === 'function' ? (value as Resolver<T>) : () => value
}

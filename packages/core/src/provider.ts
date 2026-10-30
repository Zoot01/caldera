import type { Context } from 'hono'
import type { RegisteredConfig, RegisteredEnv } from './register.js'

const SINGLETON = Symbol.for('caldera.singleton')

/** A lazily created, memoized service: built on first use, once per process (or isolate on edge). */
export interface Singleton<T> {
  readonly [SINGLETON]: true
  readonly factory: () => T
}

export function singleton<T>(factory: () => T): Singleton<T> {
  return { [SINGLETON]: true, factory }
}

export function isSingleton(value: unknown): value is Singleton<unknown> {
  return typeof value === 'object' && value !== null && SINGLETON in value
}

type Unwrap<V> = V extends Singleton<infer T> ? T : V

export type ServicesFrom<R> = { readonly [K in keyof R]: Unwrap<R[K]> }

export type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never

export interface RegisterContext<Deps> {
  readonly env: RegisteredEnv
  readonly config: RegisteredConfig
  /** Services from the providers in `dependsOn`, resolved lazily on first access. */
  readonly services: Deps
  singleton<T>(factory: () => T): Singleton<T>
  /**
   * The request being handled right now, when the app was created with `asyncContext`; undefined
   * outside a request or without it. For services that need the request later, e.g. `waitUntil`.
   */
  current(): { readonly context: Context } | undefined
}

export interface LifecycleContext<Services> {
  readonly env: RegisteredEnv
  readonly config: RegisteredConfig
  readonly services: Services
}

export type RequestFactories<Q, Services> = { [K in keyof Q]: (c: Context, services: Services) => Q[K] }

export interface ProviderDefinition<N extends string, R, Q> {
  readonly kind: 'caldera.provider'
  readonly name: N
  readonly dependsOn: readonly AnyProvider[]
  // Callbacks are stored loosely typed; `defineProvider` checks them at the call site.
  readonly register?: (app: RegisterContext<any>) => R
  readonly request?: RequestFactories<Q, any>
  readonly boot?: (app: LifecycleContext<any>) => void | Promise<void>
  readonly shutdown?: (app: LifecycleContext<any>) => void | Promise<void>
}

export type AnyProvider = ProviderDefinition<string, any, any>

export type ServicesOf<P> = P extends ProviderDefinition<string, infer R, unknown> ? ServicesFrom<R> : never
export type RequestServicesOf<P> = P extends ProviderDefinition<string, unknown, infer Q> ? Q : never

type DepsServices<D extends readonly AnyProvider[]> = UnionToIntersection<ServicesOf<D[number]>>

export function defineProvider<
  const N extends string,
  const D extends readonly AnyProvider[] = [],
  R extends Record<string, unknown> = {},
  Q extends Record<string, unknown> = {},
>(definition: {
  name: N
  /** Providers whose services this one uses. Determines boot order. */
  dependsOn?: D
  /** Binds process-wide services. Wrap expensive ones in `app.singleton()` so they're built lazily. */
  register?: (app: RegisterContext<DepsServices<D>>) => R
  /** Per-request services, one factory per name. Keep them cheap: they run on every request. */
  request?: RequestFactories<Q, ServicesFrom<R> & DepsServices<D>>
  /** Runs once after every provider has registered. On edge this happens on the first request. */
  boot?: (app: LifecycleContext<ServicesFrom<R> & DepsServices<D>>) => void | Promise<void>
  /** Node/Bun only. Never guaranteed to run on edge runtimes. */
  shutdown?: (app: LifecycleContext<ServicesFrom<R> & DepsServices<D>>) => void | Promise<void>
}): ProviderDefinition<N, R, Q> {
  return { kind: 'caldera.provider', dependsOn: [], ...definition }
}

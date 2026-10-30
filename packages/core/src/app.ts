import type { Context, MiddlewareHandler } from 'hono'
import type { AnyConfigDefinition, ConfigMap } from './config.js'
import { describeApp, type AppDescription } from './describe.js'
import type { AnyEnvDefinition, EnvOf } from './env.js'
import { BootError, NotBootedError } from './errors.js'
import {
  isSingleton,
  singleton,
  type AnyProvider,
  type RequestServicesOf,
  type ServicesOf,
  type UnionToIntersection,
} from './provider.js'

/** Structural type for `AsyncLocalStorage`, so core never imports `node:async_hooks` itself. */
export interface AsyncLocalStorageLike<T> {
  run<R>(store: T, fn: () => R): R
  getStore(): T | undefined
}
export type AsyncLocalStorageConstructor = new <T>() => AsyncLocalStorageLike<T>

export type AppState = 'created' | 'booting' | 'booted' | 'shutting-down' | 'shutdown'

export type AppServices<P extends readonly AnyProvider[]> = UnionToIntersection<ServicesOf<P[number]>>
export type AppRequestServices<P extends readonly AnyProvider[]> = UnionToIntersection<RequestServicesOf<P[number]>>

/** The Hono env an app's middleware provides: `new Hono<HonoEnvOf<typeof app>>()`. */
export type HonoEnvOf<A> = A extends CalderaApp<any, any, infer P> ? { Variables: AppServices<P> & AppRequestServices<P> & object } : never

export interface RequestScope {
  readonly context: Context
}

export interface CreateAppOptions<E extends AnyEnvDefinition, C extends readonly AnyConfigDefinition[], P extends readonly AnyProvider[]> {
  env: E
  config?: C
  providers?: P
  /** Pass `AsyncLocalStorage` (from `node:async_hooks`) to enable `app.current()`. Omit on runtimes without it. */
  asyncContext?: AsyncLocalStorageConstructor
}

export interface BootOptions {
  /** Raw env source. Defaults to `process.env` where it exists. */
  env?: Record<string, unknown>
}

export interface CalderaApp<E extends AnyEnvDefinition, C extends readonly AnyConfigDefinition[], P extends readonly AnyProvider[]> {
  readonly state: AppState
  readonly env: EnvOf<E>
  readonly config: ConfigMap<C>
  /** Process-wide services. Singletons are built on first access. */
  readonly services: AppServices<P>
  /** Idempotent: concurrent and repeated calls share one boot. */
  boot(options?: BootOptions): Promise<CalderaApp<E, C, P>>
  /** Runs provider `shutdown` hooks in reverse boot order. Node/Bun only. */
  shutdown(): Promise<void>
  /** Hono middleware that boots lazily (edge) and puts every service on `c.var`. */
  middleware(): MiddlewareHandler<HonoEnvOf<CalderaApp<E, C, P>>>
  /** The current request scope. Requires `asyncContext`. */
  current(): RequestScope | undefined
  describe(): AppDescription
}

interface Booted {
  env: Record<string, unknown>
  config: Record<string, unknown>
  services: Record<string, unknown>
  registered: Record<string, { name: string; lifetime: 'singleton' | 'value' }[]>
}

export function createApp<
  const E extends AnyEnvDefinition,
  const C extends readonly AnyConfigDefinition[] = [],
  const P extends readonly AnyProvider[] = [],
>(options: CreateAppOptions<E, C, P>): CalderaApp<E, C, P> {
  const configs: readonly AnyConfigDefinition[] = options.config ?? []
  const providers: readonly AnyProvider[] = options.providers ?? []
  const order = sortProviders(providers)
  assertUniqueConfigNames(configs)
  const scope = options.asyncContext ? new options.asyncContext<RequestScope>() : undefined

  let state: AppState = 'created'
  let booted: Booted | undefined
  let booting: Promise<void> | undefined

  const requireBooted = (what: string): Booted => {
    if (!booted) throw new NotBootedError(what)
    return booted
  }

  async function doBoot(source: Record<string, unknown>) {
    state = 'booting'
    const env = options.env.parse(source) as Record<string, unknown>

    const config: Record<string, unknown> = {}
    for (const definition of configs) config[definition.name] = deepFreeze(definition.resolve(env as never))
    Object.freeze(config)

    const services: Record<string, unknown> = {}
    const owner = new Map<string, string>()
    const registeredByProvider: Booted['registered'] = {}
    for (const provider of order) {
      const deps = servicesView(services, provider.dependsOn.map((d) => d.name), owner)
      const registered = provider.register?.({ env: env as never, config: config as never, services: deps, singleton, current: () => scope?.getStore() }) ?? {}
      for (const [key, value] of Object.entries(registered)) {
        const previous = owner.get(key)
        if (previous) {
          throw new BootError('duplicate_service', `Service "${key}" is registered by both "${previous}" and "${provider.name}".`)
        }
        owner.set(key, provider.name)
        defineService(services, key, value)
        ;(registeredByProvider[provider.name] ??= []).push({ name: key, lifetime: isSingleton(value) ? 'singleton' : 'value' })
      }
      for (const key of Object.keys(provider.request ?? {})) {
        const previous = owner.get(key)
        if (previous) {
          throw new BootError('duplicate_service', `Service "${key}" is registered by both "${previous}" and "${provider.name}".`)
        }
        owner.set(key, provider.name)
      }
    }
    Object.freeze(services)

    booted = { env, config, services, registered: registeredByProvider }
    for (const provider of order) await provider.boot?.({ env: env as never, config: config as never, services: services as never })
    state = 'booted'
  }

  const app: CalderaApp<E, C, P> = {
    get state() {
      return state
    },
    get env() {
      return requireBooted('app.env').env as EnvOf<E>
    },
    get config() {
      return requireBooted('app.config').config as ConfigMap<C>
    },
    get services() {
      return requireBooted('app.services').services as AppServices<P>
    },

    async boot(bootOptions = {}) {
      if (state === 'shutting-down' || state === 'shutdown') {
        throw new BootError('app_shut_down', 'Cannot boot an app that has been shut down.')
      }
      booting ??= doBoot(bootOptions.env ?? defaultEnvSource()).catch((error: unknown) => {
        // Let a later call retry, e.g. after fixing a missing env var in dev.
        booting = undefined
        booted = undefined
        state = 'created'
        throw error
      })
      await booting
      return app
    },

    async shutdown() {
      if (state !== 'booted') return
      state = 'shutting-down'
      const { env, config, services } = booted!
      const errors: unknown[] = []
      for (const provider of [...order].reverse()) {
        try {
          await provider.shutdown?.({ env: env as never, config: config as never, services: services as never })
        } catch (error) {
          errors.push(error)
        }
      }
      state = 'shutdown'
      if (errors.length) throw new AggregateError(errors, 'One or more providers failed to shut down.')
    },

    middleware() {
      return async (c, next) => {
        if (state !== 'booted') await app.boot({ env: envSourceFor(c) })
        const { services } = booted!
        for (const key of Object.keys(services)) c.set(key as never, services[key] as never)
        for (const provider of order) {
          for (const [key, factory] of Object.entries(provider.request ?? {})) {
            c.set(key as never, (factory as (c: Context, s: unknown) => unknown)(c, servicesView(services, null)) as never)
          }
        }
        if (scope) return scope.run({ context: c }, next)
        return next()
      }
    },

    current() {
      return scope?.getStore()
    },

    describe() {
      return describeApp({ state, envDefinition: options.env, configs, order, booted })
    },
  }

  return app
}

function defaultEnvSource(): Record<string, unknown> {
  const proc = (globalThis as { process?: { env?: Record<string, unknown> } }).process
  return proc?.env ?? {}
}

// On Workers the bindings and vars arrive per request as `c.env`; elsewhere fall back to process.env.
function envSourceFor(c: Context): Record<string, unknown> {
  const bindings = c.env as unknown
  if (bindings && typeof bindings === 'object' && Object.keys(bindings).length > 0) {
    return { ...defaultEnvSource(), ...(bindings as Record<string, unknown>) }
  }
  return defaultEnvSource()
}

function defineService(target: Record<string, unknown>, key: string, value: unknown) {
  if (!isSingleton(value)) {
    Object.defineProperty(target, key, { value, enumerable: true })
    return
  }
  let resolved = false
  let instance: unknown
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      if (!resolved) {
        instance = value.factory()
        resolved = true
      }
      return instance
    },
  })
}

/**
 * A read-only view over the registered services. With `allowed`, only services from
 * those providers are visible, so a provider can't silently depend on one it didn't declare.
 */
function servicesView(services: Record<string, unknown>, allowed: string[] | null, owner?: Map<string, string>) {
  return new Proxy(services, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (allowed && owner && !allowed.includes(owner.get(key) ?? '')) {
        const from = owner.get(key)
        const hint = from ? `Add "${from}" to dependsOn.` : 'No provider registers it.'
        throw new BootError('undeclared_dependency', `Service "${key}" isn't available here. ${hint}`)
      }
      return target[key]
    },
    set() {
      return false
    },
  })
}

/** Orders providers so every provider comes after its dependencies. Dependencies are included automatically. */
export function sortProviders(providers: readonly AnyProvider[]): AnyProvider[] {
  const sorted: AnyProvider[] = []
  const byName = new Map<string, AnyProvider>()
  const visiting = new Set<string>()
  const done = new Set<string>()

  const visit = (provider: AnyProvider, path: string[]) => {
    const existing = byName.get(provider.name)
    if (existing && existing !== provider) {
      throw new BootError('duplicate_provider', `Two different providers are named "${provider.name}".`)
    }
    byName.set(provider.name, provider)
    if (done.has(provider.name)) return
    if (visiting.has(provider.name)) {
      const cycle = [...path.slice(path.indexOf(provider.name)), provider.name].join(' → ')
      throw new BootError('provider_cycle', `Providers depend on each other in a cycle: ${cycle}`, { cycle })
    }
    visiting.add(provider.name)
    for (const dependency of provider.dependsOn) visit(dependency, [...path, provider.name])
    visiting.delete(provider.name)
    done.add(provider.name)
    sorted.push(provider)
  }

  for (const provider of providers) visit(provider, [])
  return sorted
}

function assertUniqueConfigNames(configs: readonly AnyConfigDefinition[]) {
  const seen = new Set<string>()
  for (const { name } of configs) {
    if (seen.has(name)) throw new BootError('duplicate_config', `Two config definitions are named "${name}".`)
    seen.add(name)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  } else if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

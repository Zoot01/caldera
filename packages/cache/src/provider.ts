import { createManager, defineProvider, type DriverDefinition, type Manager, type RegisterContext } from '@caldera/core'
import { createCache, type Cache } from './cache.js'
import { memoryDriver } from './memory.js'
import { redisDriver } from './redis.js'
import type { CacheCapabilities, CacheStore } from './store.js'

export interface CacheConfig<N extends string = string> {
  default: NoInfer<N>
  stores: Record<N, { driver: string; [option: string]: unknown }>
  /** Key prefix for every store. Default `caldera`. */
  prefix?: string
}

/** `c.var.cache`: the default store, plus `store(name)` for the others. */
export type CacheService<N extends string = string> = Cache & {
  store(name: N): Cache
  readonly manager: Manager<CacheStore, CacheCapabilities, N>
}

export const CACHE_DRIVERS: readonly DriverDefinition<CacheStore, CacheCapabilities>[] = [memoryDriver, redisDriver]

export function createCacheService<const N extends string>(config: CacheConfig<N>, drivers: readonly DriverDefinition<CacheStore, CacheCapabilities>[] = CACHE_DRIVERS): CacheService<N> {
  const manager = createManager({ kind: 'cache', drivers, config: { default: config.default, instances: config.stores } })
  const caches = new Map<string, Cache>()
  const store = (name: N) => {
    let cache = caches.get(name)
    if (!cache) {
      cache = createCache({ name, store: manager.use(name), capabilities: manager.capabilities(name), ...(config.prefix ? { prefix: config.prefix } : {}) })
      caches.set(name, cache)
    }
    return cache
  }
  // The default store's methods, resolved on each call so the store is still created lazily.
  const service = new Proxy({} as CacheService<N>, {
    get(_target, key) {
      if (key === 'store') return store
      if (key === 'manager') return manager
      const value = store(config.default)[key as keyof Cache]
      return typeof value === 'function' ? value.bind(store(config.default)) : value
    },
  })
  return service
}

/**
 * Registers `cache` from your config: `cacheProvider((app) => app.config.cache)`. Stores connect on
 * first use; their config is checked at boot. Extra drivers (your own, or from other packages) go in `drivers`.
 */
export function cacheProvider<const N extends string>(
  resolve: (app: RegisterContext<unknown>) => CacheConfig<N>,
  options: { drivers?: readonly DriverDefinition<CacheStore, CacheCapabilities>[] } = {},
) {
  return defineProvider({
    name: 'cache',
    register: (app) => {
      const service = createCacheService(resolve(app), [...CACHE_DRIVERS, ...(options.drivers ?? [])])
      return { cache: service }
    },
    shutdown: async ({ services }) => {
      await services.cache.manager.purge()
    },
  })
}

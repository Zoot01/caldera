import type { z } from 'zod'
import { BootError, CalderaError, CapabilityError } from './errors.js'

/**
 * One backend a manager can use: the Redis cache store, the BullMQ queue, the R2 disk. `schema`
 * validates an instance's config before anything connects; `capabilities` say what it can do, so
 * code that needs (say) locks fails early and clearly on a store without them.
 */
export interface DriverDefinition<I, Caps, Cfg = any> {
  readonly kind: 'caldera.driver'
  readonly name: string
  readonly schema?: z.ZodType<Cfg>
  readonly capabilities: Caps | ((config: Cfg) => Caps)
  /** Called once per instance, on first use. */
  create(config: Cfg, context: DriverContext<I>): I
  /** Optional cleanup, e.g. closing a connection. Called by `purge()` and on app shutdown. */
  close?(instance: I): void | Promise<void>
}

export interface DriverContext<I> {
  /** The instance's name in config, e.g. `redis` in `stores.redis`. */
  readonly name: string
  /** Another instance of the same manager, for composite drivers (failover, read-through). */
  instance(name: string): I
}

export function defineDriver<I, Caps, Cfg = Record<string, never>>(definition: Omit<DriverDefinition<I, Caps, Cfg>, 'kind'>): DriverDefinition<I, Caps, Cfg> {
  return { kind: 'caldera.driver', ...definition }
}

/** What every instance config has: which driver it uses. The rest is the driver's own options. */
export interface InstanceConfig {
  driver: string
  [option: string]: unknown
}

export interface ManagerConfig<N extends string = string> {
  default: NoInfer<N>
  instances: Record<N, InstanceConfig>
}

export interface InstanceDescription<Caps> {
  name: string
  driver: string
  default: boolean
  capabilities: Caps
  /** Whether it has been created yet (instances are lazy). */
  created: boolean
}

export interface Manager<I, Caps, N extends string = string> {
  readonly kind: string
  readonly defaultName: N
  /** The named instance (or the default), created on first use and memoized. */
  use(name?: N): I
  capabilities(name?: N): Caps
  /**
   * Throws `CapabilityError` unless the instance supports `capability`. Call it where a feature
   * needs one (locks, atomic counters) so the failure names the store and the fix.
   */
  require(capability: keyof Caps & string, options?: { name?: N; hint?: string }): void
  /** Registers another driver, e.g. one an app or package wrote. */
  extend(driver: DriverDefinition<I, Caps>): void
  /** Drops (and closes) instances so the next `use()` creates them again. */
  purge(name?: N): Promise<void>
  describe(): { kind: string; default: N; instances: InstanceDescription<Caps>[] }
}

/**
 * The manager pattern, written once (Laravel re-implements it per subsystem). A package defines its
 * drivers; the app's config picks instances: `{ default: 'redis', instances: { redis: { driver: 'redis', url } } }`.
 * Every instance config is validated up front, so a typo fails at boot, not on the first request.
 */
export function createManager<I, Caps, const N extends string>(options: {
  kind: string
  drivers: readonly DriverDefinition<I, Caps>[]
  config: ManagerConfig<N>
  /** How to get drivers that ship separately, by name, for the "unknown driver" error. */
  hints?: Record<string, string>
}): Manager<I, Caps, N> {
  const { kind, config } = options
  const drivers = new Map<string, DriverDefinition<I, Caps>>()
  for (const driver of options.drivers) drivers.set(driver.name, driver)
  const created = new Map<string, I>()
  const resolving = new Set<string>()

  const names = Object.keys(config.instances) as N[]
  if (!names.includes(config.default)) {
    throw new BootError('manager_default_missing', `${kind}: the default "${config.default}" isn't one of the configured instances (${names.join(', ') || 'none'}).`)
  }

  const driverFor = (name: string) => {
    const instance = config.instances[name as N]
    if (!instance) throw new CalderaError('instance_missing', `${kind}: no instance named "${name}". Configured: ${names.join(', ')}.`, { kind, name })
    const driver = drivers.get(instance.driver)
    if (!driver) {
      const hint = options.hints?.[instance.driver]
      throw new BootError('driver_missing', `${kind}.${name}: unknown driver "${instance.driver}". ${hint ?? `Available: ${[...drivers.keys()].join(', ')}.`}`, { kind, name, driver: instance.driver })
    }
    return { instance, driver }
  }

  const parsed = new Map<string, unknown>()
  const configOf = (name: string) => {
    if (parsed.has(name)) return parsed.get(name)
    const { instance, driver } = driverFor(name)
    const { driver: _driver, ...rest } = instance
    let value: unknown = rest
    if (driver.schema) {
      const result = driver.schema.safeParse(rest)
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`).join('; ')
        throw new BootError('instance_config_invalid', `${kind}.${name} (${driver.name}): ${issues}`, { kind, name, issues: result.error.issues })
      }
      value = result.data
    }
    parsed.set(name, value)
    return value
  }
  // Validate everything now: a bad config is a boot error, not a surprise on first use.
  for (const name of names) configOf(name)

  const capabilitiesOf = (name: string): Caps => {
    const { driver } = driverFor(name)
    return typeof driver.capabilities === 'function' ? (driver.capabilities as (c: unknown) => Caps)(configOf(name)) : driver.capabilities
  }

  const manager: Manager<I, Caps, N> = {
    kind,
    defaultName: config.default,
    use(name = config.default) {
      const existing = created.get(name)
      if (existing !== undefined) return existing
      if (resolving.has(name)) throw new BootError('instance_cycle', `${kind}.${name} refers to itself through other instances.`)
      resolving.add(name)
      try {
        const { driver } = driverFor(name)
        const instance = driver.create(configOf(name), { name, instance: (other) => manager.use(other as N) })
        created.set(name, instance)
        return instance
      } finally {
        resolving.delete(name)
      }
    },
    capabilities: (name = config.default) => capabilitiesOf(name),
    require(capability, { name = config.default, hint } = {}) {
      const caps = capabilitiesOf(name) as Record<string, unknown>
      if (!caps[capability]) throw new CapabilityError(`${kind}.${name} (${driverFor(name).driver.name})`, capability, hint)
    },
    extend(driver) {
      drivers.set(driver.name, driver)
    },
    async purge(name) {
      for (const key of name ? [name] : [...created.keys()]) {
        const instance = created.get(key)
        if (instance === undefined) continue
        created.delete(key)
        await driverFor(key).driver.close?.(instance)
      }
    },
    describe() {
      return {
        kind,
        default: config.default,
        instances: names.map((name) => ({
          name,
          driver: driverFor(name).driver.name,
          default: name === config.default,
          capabilities: capabilitiesOf(name),
          created: created.has(name),
        })),
      }
    },
  }
  return manager
}

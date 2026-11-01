import { defineProvider, type DriverDefinition, type RegisterContext } from '@caldera-js/core'
import type { QueueCapabilities, QueueDriver } from './driver.js'
import { createQueue, setDefaultQueue, type Queue, type QueueConfig, type QueueStore } from './queue.js'

/**
 * Registers `queue` from your config: `queueProvider((app) => app.config.queue)`. Unique-job locks and
 * batch counters live in the app's `cache` service (add `cacheProvider()`), or in `store` if given.
 * It also becomes the default for `dispatch()`. Jobs get the app's services as `context.services`, and its config as `context.config`.
 */
export function queueProvider<const N extends string>(
  resolve: (app: RegisterContext<unknown>) => QueueConfig<N>,
  options: { drivers?: readonly DriverDefinition<QueueDriver, QueueCapabilities>[]; store?: (services: Record<string, unknown>) => QueueStore } = {},
) {
  return defineProvider({
    name: 'queue',
    register: (app) => {
      // Services are set at boot (below); the store is read lazily, when a job needs it.
      const queue: Queue<N> = createQueue(resolve(app), {
        ...(options.drivers ? { drivers: options.drivers } : {}),
        // Default: the app's `cache` service (from cacheProvider), when there is one.
        store: (): QueueStore | undefined => {
          const services = queue.services as Record<string, unknown>
          return options.store ? options.store(services) : (services.cache as QueueStore | undefined)
        },
        waitUntil: () => {
          const c = app.current()?.context
          try {
            // Hono's executionCtx getter throws on runtimes without one (Node).
            const ctx = c?.executionCtx
            return ctx ? (promise) => ctx.waitUntil(promise) : undefined
          } catch {
            return undefined
          }
        },
      })
      setDefaultQueue(queue)
      return { queue }
    },
    boot: ({ services, config }) => {
      services.queue.services = services as never
      services.queue.config = config
    },
    shutdown: async ({ services }) => {
      await services.queue.manager.purge()
    },
  })
}

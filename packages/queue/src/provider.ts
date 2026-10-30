import { defineProvider, type DriverDefinition, type RegisterContext } from '@caldera/core'
import type { QueueCapabilities, QueueDriver } from './driver.js'
import { createQueue, QUEUE_DRIVERS, setDefaultQueue, type Queue, type QueueConfig, type QueueStore } from './queue.js'

/**
 * Registers `queue` from your config: `queueProvider((app) => app.config.queue, { store: (s) => s.cache })`.
 * The store holds unique-job locks and batch counters.
 * It also becomes the default for `dispatch()`. Jobs get the app's services as `context.services`.
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
        drivers: [...QUEUE_DRIVERS, ...(options.drivers ?? [])],
        ...(options.store ? { store: (): QueueStore => options.store!(queue.services as Record<string, unknown>) } : {}),
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
    boot: ({ services }) => {
      services.queue.services = services as never
    },
    shutdown: async ({ services }) => {
      await services.queue.manager.purge()
    },
  })
}

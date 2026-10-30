import { defineProvider, type DriverDefinition, type RegisterContext } from '@caldera/core'
import type { QueueCapabilities, QueueDriver } from './driver.js'
import { createQueue, QUEUE_DRIVERS, setDefaultQueue, type Queue, type QueueConfig, type UniqueLocks } from './queue.js'

/**
 * Registers `queue` from your config: `queueProvider((app) => app.config.queue, { locks: (s) => s.cache })`.
 * It also becomes the default for `dispatch()`. Jobs get the app's services as `context.services`.
 */
export function queueProvider<const N extends string>(
  resolve: (app: RegisterContext<unknown>) => QueueConfig<N>,
  options: { drivers?: readonly DriverDefinition<QueueDriver, QueueCapabilities>[]; locks?: (services: Record<string, unknown>) => UniqueLocks } = {},
) {
  return defineProvider({
    name: 'queue',
    register: (app) => {
      // Services are set at boot (below); unique locks read them lazily, at dispatch time.
      const queue: Queue<N> = createQueue(resolve(app), {
        drivers: [...QUEUE_DRIVERS, ...(options.drivers ?? [])],
        ...(options.locks ? { locks: (): UniqueLocks => options.locks!(queue.services as Record<string, unknown>) } : {}),
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

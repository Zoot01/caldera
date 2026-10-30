import type { Hono } from 'hono'
import { hc, type ClientRequestOptions } from 'hono/client'

// This browser's realtime connection id, from @caldera/broadcast/client's state when it's in use.
const socketId = (): string | undefined =>
  ((globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.broadcast.client')] as { transport?: { socketId(): string | undefined } } | undefined)?.transport?.socketId()

/**
 * A typed client for the app's routes, for client components: `createClient<AppType>('/api')`,
 * where `AppType` is `typeof router.app` (export it from a server file as a type only).
 * Calls carry the browser's cookies, so signed-in requests and the app session work, and the
 * realtime connection's id (X-Socket-ID), so `emit(…, { toOthers: true })` skips this browser.
 */
export function createClient<T extends Hono<any, any, any>>(baseUrl = '/api', options: ClientRequestOptions = {}): ReturnType<typeof hc<T>> {
  const own = options.headers
  return hc<T>(baseUrl, {
    init: { credentials: 'same-origin' },
    ...options,
    headers: async () => {
      const base = typeof own === 'function' ? await own() : (own ?? {})
      const id = socketId()
      return id ? { ...base, 'X-Socket-ID': id } : base
    },
  })
}

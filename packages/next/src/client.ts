import type { Hono } from 'hono'
import { hc, type ClientRequestOptions } from 'hono/client'

/**
 * A typed client for the app's routes, for client components: `createClient<AppType>('/api')`,
 * where `AppType` is `typeof router.app` (export it from a server file as a type only).
 * Calls carry the browser's cookies, so signed-in requests and the app session work.
 */
export function createClient<T extends Hono<any, any, any>>(baseUrl = '/api', options: ClientRequestOptions = {}): ReturnType<typeof hc<T>> {
  return hc<T>(baseUrl, { init: { credentials: 'same-origin' }, ...options })
}

// A Worker with the hub, as src/worker.ts sets it up: hub requests first, then the app (here, one
// route that publishes through the durable-object driver, as the app would on Workers).
import { BroadcastHub, broadcastHubRoute, durableObjectDriver, type BroadcastHubEnv, type DurableObjectNamespaceLike } from '../../src/cloudflare.js'

export { BroadcastHub }

export default {
  async fetch(request: Request, env: BroadcastHubEnv & { BROADCAST_HUB: DurableObjectNamespaceLike }) {
    const hub = broadcastHubRoute(request, env)
    if (hub) return hub
    const url = new URL(request.url)
    if (url.pathname === '/publish' && request.method === 'POST') {
      const driver = durableObjectDriver.create(
        durableObjectDriver.schema!.parse({ binding: env.BROADCAST_HUB, appId: env.BROADCAST_APP_ID, key: env.BROADCAST_KEY, secret: env.BROADCAST_SECRET }),
        { name: 'hub', instance: () => undefined as never },
      )
      await driver.publish((await request.json()) as never)
      return Response.json({ ok: true, client: driver.client(url) })
    }
    return new Response('app', { status: 200 })
  },
}

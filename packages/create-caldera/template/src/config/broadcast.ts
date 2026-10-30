import { defineConfig } from '@caldera/core'

export const broadcast = defineConfig('broadcast', (env) => {
  // A self-hosted server (ours, or the Durable Object) shares a secret with the app: BROADCAST_SECRET,
  // or by default one both derive from APP_KEY.
  const own = { appId: env.BROADCAST_APP_ID, key: env.BROADCAST_KEY, secret: env.BROADCAST_SECRET, appKey: env.APP_KEY }
  // Where browsers connect, when that isn't BROADCAST_HOST (a public hostname in front of it).
  const browser = env.BROADCAST_PUBLIC_URL ? new URL(env.BROADCAST_PUBLIC_URL) : undefined
  const secure = browser?.protocol === 'wss:' || browser?.protocol === 'https:'
  return {
    // Tests send nothing (t.fake('broadcast') records broadcasts instead).
    default: env.NODE_ENV === 'test' ? 'null' : env.BROADCAST_CONNECTION,
    connections: {
      // A pusher-protocol server: `caldera dev` starts one on BROADCAST_PORT; `pnpm realtime` runs it
      // in production (or point BROADCAST_HOST at Soketi or Reverb, with their secret).
      server: {
        driver: 'pusher',
        ...own,
        host: env.BROADCAST_HOST,
        port: env.BROADCAST_PORT,
        scheme: env.BROADCAST_SCHEME,
        // With Redis, run `pnpm realtime` on several machines: they share connections and presence.
        ...(env.REDIS_URL ? { redis: env.REDIS_URL } : {}),
        ...(browser ? { client: { host: browser.hostname, port: Number(browser.port) || (secure ? 443 : 80), scheme: secure ? ('https' as const) : ('http' as const) } } : {}),
      },
      // Server-sent events from the app itself: no realtime server, one-way (no presence, no whispers).
      // Node and Bun; with Redis, several app processes share broadcasts.
      sse: { driver: 'sse', ...(env.REDIS_URL ? { redis: env.REDIS_URL } : {}) },
      // Hosted Pusher.
      ...(env.PUSHER_KEY ? { pusher: { driver: 'pusher', appId: env.PUSHER_APP_ID ?? '', key: env.PUSHER_KEY, secret: env.PUSHER_SECRET, cluster: env.PUSHER_CLUSTER ?? 'mt1' } } : {}),
      // Cloudflare Workers: the BroadcastHub Durable Object (`caldera cloudflare:setup`).
      ...(env.BROADCAST_HUB ? { cloudflare: { driver: 'durable-object', binding: env.BROADCAST_HUB, ...own } } : {}),
      // The default: broadcasts are written to the log, and browsers don't connect.
      log: { driver: 'log' },
      null: { driver: 'null' },
    },
  }
})

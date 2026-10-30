import { CalderaError, defineConfig } from '@caldera/core'

export const broadcast = defineConfig('broadcast', (env) => {
  // Tests send nothing (t.fake('broadcast') records broadcasts instead).
  const connection = env.NODE_ENV === 'test' ? 'null' : env.BROADCAST_CONNECTION
  const secret = env.BROADCAST_SECRET
  if (!secret && connection !== 'log' && connection !== 'null') {
    throw new CalderaError('broadcast_secret_missing', `BROADCAST_CONNECTION=${connection} needs BROADCAST_SECRET (a long random string the realtime server shares). Without realtime, set BROADCAST_CONNECTION=null.`)
  }
  const credentials = { appId: env.BROADCAST_APP_ID, key: env.BROADCAST_KEY, secret: secret ?? '' }
  // Where browsers connect, when that isn't BROADCAST_HOST (a public hostname in front of it).
  const browser = env.BROADCAST_PUBLIC_URL ? new URL(env.BROADCAST_PUBLIC_URL) : undefined
  const secure = browser?.protocol === 'wss:' || browser?.protocol === 'https:'
  return {
    default: connection,
    connections: {
      // A pusher-protocol server: `caldera dev` starts one on BROADCAST_PORT; `pnpm realtime` runs it
      // in production (or point BROADCAST_HOST at Soketi or Reverb).
      ...(secret
        ? {
            server: {
              driver: 'pusher',
              ...credentials,
              host: env.BROADCAST_HOST,
              port: env.BROADCAST_PORT,
              scheme: env.BROADCAST_SCHEME,
              ...(browser ? { client: { host: browser.hostname, port: Number(browser.port) || (secure ? 443 : 80), scheme: secure ? ('https' as const) : ('http' as const) } } : {}),
            },
          }
        : {}),
      // Hosted Pusher: the app id, key and secret from its dashboard, and PUSHER_CLUSTER.
      ...(secret && env.PUSHER_CLUSTER ? { pusher: { driver: 'pusher', ...credentials, cluster: env.PUSHER_CLUSTER } } : {}),
      // Cloudflare Workers: the BroadcastHub Durable Object (`caldera cloudflare:setup`).
      ...(secret && env.BROADCAST_HUB ? { cloudflare: { driver: 'durable-object', binding: env.BROADCAST_HUB, ...credentials } } : {}),
      log: { driver: 'log' },
      null: { driver: 'null' },
    },
  }
})

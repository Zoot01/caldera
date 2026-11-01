import { defineConfig } from '@caldera-js/core'

export const broadcast = defineConfig('broadcast', (env) => ({
  default: env.BROADCAST_CONNECTION,
  connections: {
    server: { driver: 'pusher', appId: 'fixture', key: 'fixture-key', secret: 'fixture-secret', host: '127.0.0.1', port: env.BROADCAST_PORT },
    log: { driver: 'log' },
  },
}))

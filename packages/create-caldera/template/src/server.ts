import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { http } from './http.js'

// Local development reads .env; variables already set in the environment (production) win.
if (existsSync('.env')) process.loadEnvFile('.env')

await app.boot()
serve({ fetch: http.fetch, port: app.config.app.port }, (info) => {
  console.log(`{{ name }} is running on http://localhost:${info.port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.shutdown().finally(() => process.exit(0)))
}

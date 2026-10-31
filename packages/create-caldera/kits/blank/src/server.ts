import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { app } from './app.js'
import { http } from './http.js'

// Local development reads .env; variables already set in the environment (production) win.
if (existsSync('.env')) process.loadEnvFile('.env')

await app.boot()
// Files in public/ (including the Vite build in public/build) are served as they are.
const server = new Hono().use(serveStatic({ root: './public' })).route('/', http)
serve({ fetch: server.fetch, port: app.config.app.port }, (info) => {
  console.log(`{{ name }} is running on http://localhost:${info.port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.shutdown().finally(() => process.exit(0)))
}

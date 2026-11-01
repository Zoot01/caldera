import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { serveBroadcast } from '@caldera-js/broadcast/server'
import { migrateFresh, testDatabaseUrl } from '@caldera-js/testing/database'
import next from 'next'

// The app Playwright drives (playwright.config.ts starts it once `next build` is done): the build, on a
// database and a storage folder of its own, emptied on every run. The database is a SQLite file, or
// DATABASE_TEST_URL on Postgres (the database `pnpm test` uses, which it resets too).
if (existsSync('.env')) process.loadEnvFile('.env')
// CI has no .env: a throwaway key.
process.env.APP_KEY ||= randomBytes(32).toString('base64url')
const sqlite = '.caldera/browser.db'
const url = testDatabaseUrl() ?? `file:${sqlite}`
process.env.DATABASE_URL = url
for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(sqlite + suffix, { force: true })
// Uploads too, so they never land among development's files in storage/app.
process.env.STORAGE_ROOT = '.caldera/browser-storage'
rmSync(process.env.STORAGE_ROOT, { recursive: true, force: true })

const { app } = await import('../../src/app')
await app.boot()
await migrateFresh(app.services.db, 'drizzle', url)
// The realtime server (on BROADCAST_PORT), so pages connect and live updates can be tested.
await serveBroadcast(app)

// Next serves the build, in this process's environment (the settings above).
const port = Number(process.env.PORT ?? 3100)
const server = next({ dev: false, dir: process.cwd(), port })
await server.prepare()
const handle = server.getRequestHandler()
createServer((req, res) => void handle(req, res)).listen(port)

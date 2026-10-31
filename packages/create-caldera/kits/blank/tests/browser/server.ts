import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { migrateFresh, testDatabaseUrl } from '@caldera/testing/database'

// The app Playwright drives (playwright.config.ts starts it once the build is done): src/server.ts on a
// database and a storage folder of its own, emptied on every run. The database is a SQLite file, or
// DATABASE_TEST_URL on Postgres (the database `{{ run }} test` uses, which it resets too).
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
await import('../../src/server')

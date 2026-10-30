import { defineEnv, secret } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({
  APP_URL: z.url().default('http://localhost:3000'),
  APP_KEY: secret(z.string().min(32)),
  DATABASE_URL: z.string().default('file:local.db'),
  PORT: z.coerce.number().default(3000),
  QUEUE_CONNECTION: z.enum(['sync', 'deferred', 'database', 'redis']).default('sync'),
  // Empty means "no Redis": the cache stays in memory and the redis queue isn't configured.
  REDIS_URL: z.string().optional().transform((url) => url || undefined),
  // S3-compatible storage (S3, R2, Tigris…). Unset: files stay on this machine (storage/app).
  S3_BUCKET: z.string().optional().transform((s) => s || undefined),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional().transform((s) => s || undefined),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: secret(z.string().optional()),
  // Vercel sends it to the cron route (Authorization: Bearer ...). Empty: the route is off.
  CRON_SECRET: secret(z.string().optional().transform((s) => s || undefined)),
})

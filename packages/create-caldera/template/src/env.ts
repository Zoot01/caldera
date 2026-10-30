import { defineEnv, secret } from '@caldera/core'
import { z } from 'zod'

/** A Workers binding (an object the runtime passes in, not a string), when there is one. */
const binding = () => z.custom<object>((value) => typeof value === 'object' && value !== null).optional()

export const env = defineEnv({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.url().default('http://localhost:3000'),
  APP_KEY: secret(z.string().min(32)),
  DATABASE_URL: z.string().default('file:local.db'),
  // For a hosted libSQL database (Turso): `turso db tokens create <db>`.
  DATABASE_AUTH_TOKEN: secret(z.string().optional().transform((s) => s || undefined)),
  PORT: z.coerce.number().default(3000),
  QUEUE_CONNECTION: z.enum(['sync', 'deferred', 'database', 'redis', 'cloudflare']).default('sync'),
  // Empty means "no Redis": the cache stays in memory and the redis queue isn't configured.
  REDIS_URL: z.string().optional().transform((url) => url || undefined),
  // S3-compatible storage (S3, R2, Tigris…). Unset: files stay on this machine (storage/app).
  S3_BUCKET: z.string().optional().transform((s) => s || undefined),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional().transform((s) => s || undefined),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: secret(z.string().optional()),
  // Mail: `log` prints and keeps an outbox (/_caldera/mail/outbox); set a provider for real delivery.
  MAIL_MAILER: z.enum(['log', 'resend', 'postmark', 'ses', 'smtp', 'cloudflare']).default('log'),
  MAIL_FROM: z.string().default('{{ name }} <hello@example.com>'),
  // Development: send everything here instead of to real people.
  MAIL_REDIRECT_TO: z.string().optional().transform((s) => s || undefined),
  RESEND_API_KEY: secret(z.string().optional()),
  POSTMARK_SERVER_TOKEN: secret(z.string().optional()),
  SMTP_URL: secret(z.string().optional()),
  SES_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: secret(z.string().optional()),
  // Vercel sends it to the cron route (Authorization: Bearer ...). Empty: the route is off.
  CRON_SECRET: secret(z.string().optional().transform((s) => s || undefined)),
  // Realtime (src/config/broadcast.ts). `server`: a pusher-protocol server at BROADCAST_HOST, which
  // `caldera dev` runs for you (`pnpm realtime` in production; Soketi and Reverb work too). `pusher`:
  // hosted Pusher (PUSHER_CLUSTER). `cloudflare`: the BroadcastHub Durable Object. `log`, `null`.
  BROADCAST_CONNECTION: z.enum(['server', 'pusher', 'cloudflare', 'log', 'null']).default('server'),
  BROADCAST_APP_ID: z.string().default('{{ name }}'),
  BROADCAST_KEY: z.string().default('{{ name }}-key'),
  // Signs subscriptions and publishes; the realtime server has the same one. Needed by server, pusher and cloudflare.
  BROADCAST_SECRET: secret(z.string().min(16).optional().or(z.literal('').transform(() => undefined))),
  BROADCAST_HOST: z.string().default('127.0.0.1'),
  BROADCAST_PORT: z.coerce.number().default(6001),
  BROADCAST_SCHEME: z.enum(['http', 'https']).default('http'),
  // Where browsers connect, when it isn't BROADCAST_HOST (wss://realtime.example.com).
  BROADCAST_PUBLIC_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  PUSHER_CLUSTER: z.string().optional().transform((s) => s || undefined),
  // Cloudflare Workers bindings (wrangler.json, from `caldera cloudflare:setup`). Present only on
  // Workers, where they replace libSQL (DB: D1), the disks (FILES: R2), the queue and the mailer.
  DB: binding(),
  FILES: binding(),
  QUEUE: binding(),
  EMAIL: binding(),
  BROADCAST_HUB: binding(),
})

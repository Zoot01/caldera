import { defineEnv, secret } from '@caldera-js/core'
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
  // Proxies in front of the app whose X-Forwarded-For and -Proto to believe (the client's address for
  // rate limits, HTTPS for secure cookies): `loopback` (Caddy or nginx on this machine), addresses
  // separated by commas, or `*` for any. On Vercel its edge is trusted without this.
  TRUSTED_PROXIES: z
    .string()
    .default('loopback')
    .transform((value) => (value.trim() === '*' ? ('*' as const) : value.split(',').map((part) => part.trim()).filter(Boolean))),
  // Set by Vercel.
  VERCEL: z.string().optional(),
  QUEUE_CONNECTION: z.enum(['sync', 'deferred', 'database', 'redis', 'cloudflare']).default('sync'),
  // Empty means "no Redis": the cache stays in memory and the redis queue isn't configured.
  REDIS_URL: z.string().optional().transform((url) => url || undefined),
  // Where the local disk keeps files. Browser tests use their own (tests/browser/server.ts).
  STORAGE_ROOT: z.string().default('storage/app'),
  // S3-compatible storage (S3, R2, Tigris…). Unset: files stay on this machine (storage/app).
  S3_BUCKET: z.string().optional().transform((s) => s || undefined),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional().transform((s) => s || undefined),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: secret(z.string().optional()),
  // Mail: `log` prints and keeps an outbox (/_caldera/mail/outbox); set a provider for real delivery.
  MAIL_MAILER: z.enum(['log', 'resend', 'postmark', 'ses', 'smtp', 'cloudflare']).default('log'),
  // Sent as the app's name (config.app.name) unless it has its own: `Support <help@example.com>`.
  MAIL_FROM: z.string().default('hello@example.com'),
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
  // Realtime (src/config/broadcast.ts). Unset: broadcasts are only logged. `server`: a pusher-protocol
  // server at BROADCAST_HOST, which `caldera dev` runs for you (`pnpm realtime` in production; Soketi and
  // Reverb work too). `sse`: from the app itself (one-way: no presence or whispers). `pusher`: hosted
  // Pusher. `cloudflare`: the BroadcastHub Durable Object.
  BROADCAST_CONNECTION: z.enum(['server', 'sse', 'pusher', 'cloudflare', 'log', 'null']).default('log'),
  BROADCAST_APP_ID: z.string().default('{{ name }}'),
  BROADCAST_KEY: z.string().default('{{ name }}-key'),
  // Optional: by default the realtime server and the app derive a shared secret from APP_KEY.
  BROADCAST_SECRET: secret(z.string().optional().transform((s) => s || undefined)),
  BROADCAST_HOST: z.string().default('127.0.0.1'),
  BROADCAST_PORT: z.coerce.number().default(6001),
  BROADCAST_SCHEME: z.enum(['http', 'https']).default('http'),
  // Where browsers connect, when it isn't BROADCAST_HOST (wss://realtime.example.com).
  BROADCAST_PUBLIC_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  // Hosted Pusher: the app's credentials from its dashboard.
  PUSHER_APP_ID: z.string().optional().transform((s) => s || undefined),
  PUSHER_KEY: z.string().optional().transform((s) => s || undefined),
  PUSHER_SECRET: secret(z.string().optional().transform((s) => s || undefined)),
  PUSHER_CLUSTER: z.string().optional().transform((s) => s || undefined),
  // Cloudflare Workers bindings (wrangler.json, from `caldera cloudflare:setup`). Present only on
  // Workers, where they replace libSQL (DB: D1), the disks (FILES: R2), the queue and the mailer.
  DB: binding(),
  FILES: binding(),
  QUEUE: binding(),
  EMAIL: binding(),
  BROADCAST_HUB: binding(),
})

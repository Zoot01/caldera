import { defineConfig } from '@caldera/core'

export const app = defineConfig('app', (env) => ({
  name: '{{ name }}',
  url: env.APP_URL,
  port: env.PORT,
  cronSecret: env.CRON_SECRET,
  // Whose X-Forwarded-* headers to believe (src/http.ts: trustProxies()). On Vercel, its edge.
  trustedProxies: env.VERCEL ? ('*' as const) : env.TRUSTED_PROXIES,
}))

import { defineConfig } from '@caldera/core'

export const app = defineConfig('app', (env) => ({
  name: '{{ name }}',
  url: env.APP_URL,
  port: env.PORT,
  cronSecret: env.CRON_SECRET,
}))

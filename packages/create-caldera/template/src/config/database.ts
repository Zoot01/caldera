import { defineConfig } from '@caldera/core'

export const database = defineConfig('database', (env) => ({
  url: env.DATABASE_URL,
  authToken: env.DATABASE_AUTH_TOKEN,
}))

import { defineConfig } from '@caldera/core'

export const database = defineConfig('database', (env) => ({
  url: env.DATABASE_URL,
}))

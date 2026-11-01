import { defineConfig } from '@caldera-js/core'

export const database = defineConfig('database', (env) => ({
  url: env.DATABASE_URL,
}))

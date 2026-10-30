import { z } from 'zod'
import { defineConfig, defineEnv, secret } from '../src/index.js'

export const env = defineEnv({
  APP_URL: z.url(),
  APP_KEY: secret(z.string().min(32)),
  DATABASE_URL: z.string(),
  PORT: z.coerce.number().default(3000),
  FEATURE_FLAGS: z.string().optional(),
})

export const database = defineConfig('database', (env) => ({ url: env.DATABASE_URL, pool: { max: 10 } }))
export const site = defineConfig('site', (env) => ({ url: env.APP_URL, port: env.PORT, signingKey: env.APP_KEY }))
export const config = [database, site] as const

// What `caldera` codegen writes into `.caldera/register.d.ts` for a real app.
declare module '../src/register.js' {
  interface Register {
    env: typeof env
    config: typeof config
  }
}

export const validEnv = {
  APP_URL: 'https://example.test',
  APP_KEY: 'k'.repeat(32),
  DATABASE_URL: 'postgres://app:hunter2-super-secret@db.internal:5432/app',
  PORT: '8080',
}

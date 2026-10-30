import { defineEnv, secret } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({
  APP_URL: z.url().default('http://localhost:3000'),
  APP_KEY: secret(z.string().min(32)),
  DATABASE_URL: z.string().default('file:local.db'),
  PORT: z.coerce.number().default(3000),
})

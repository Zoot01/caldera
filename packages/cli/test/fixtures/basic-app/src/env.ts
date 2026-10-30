import { secret, defineEnv } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({
  APP_URL: z.url(),
  APP_KEY: secret(z.string().min(32)),
  DATABASE_URL: z.string(),
  PORT: z.coerce.number().default(3000),
})

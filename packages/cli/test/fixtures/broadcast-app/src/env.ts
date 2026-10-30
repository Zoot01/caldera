import { defineEnv } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({
  DATABASE_URL: z.string(),
  BROADCAST_CONNECTION: z.enum(['server', 'log']).default('server'),
  BROADCAST_PORT: z.coerce.number().default(6001),
})

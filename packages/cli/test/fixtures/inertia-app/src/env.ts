import { defineEnv } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({ APP_URL: z.url().default('http://localhost:3000') })

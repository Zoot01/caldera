import { defineEnv } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({ REDIS_URL: z.string(), OUT_DIR: z.string() })

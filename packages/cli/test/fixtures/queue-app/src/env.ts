import { defineEnv } from '@caldera-js/core'
import { z } from 'zod'

export const env = defineEnv({ REDIS_URL: z.string(), OUT_DIR: z.string() })

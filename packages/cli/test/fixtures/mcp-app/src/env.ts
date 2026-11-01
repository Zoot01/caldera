import { defineEnv } from '@caldera-js/core'
import { z } from 'zod'

export const env = defineEnv({ APP_URL: z.url(), DATABASE_URL: z.string() })

import { defineEnv } from '@caldera/core'
import { z } from 'zod'

export const env = defineEnv({ OUT_DIR: z.string().default('.') })

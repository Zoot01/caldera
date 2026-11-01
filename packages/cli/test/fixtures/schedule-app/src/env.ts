import { defineEnv } from '@caldera-js/core'
import { z } from 'zod'

export const env = defineEnv({ OUT_DIR: z.string().default('.') })

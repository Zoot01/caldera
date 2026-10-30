import { createApp } from '@caldera/core'
import { config } from '../.caldera/config.gen.js'
import { env } from './env.js'

export const app = createApp({ env, config })

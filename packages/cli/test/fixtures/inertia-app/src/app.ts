import { createApp } from '@caldera-js/core'
import { config } from '../.caldera/config.gen.js'
import { env } from './env.js'

export const app = createApp({ env, config })

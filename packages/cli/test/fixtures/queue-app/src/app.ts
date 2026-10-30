import { createApp } from '@caldera/core'
import { queueProvider } from '@caldera/queue'
import { config } from '../.caldera/config.gen.js'
import { env } from './env.js'

export const app = createApp({ env, config, providers: [queueProvider((app) => app.config.queue)] })

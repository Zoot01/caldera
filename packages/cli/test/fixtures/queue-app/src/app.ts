import { createApp } from '@caldera/core'
import { queueProvider } from '@caldera/queue'
import { bullmqDriver } from '@caldera/queue/bullmq'
import { config } from '../.caldera/config.gen.js'
import { env } from './env.js'

export const app = createApp({ env, config, providers: [queueProvider((app) => app.config.queue, { drivers: [bullmqDriver] })] })

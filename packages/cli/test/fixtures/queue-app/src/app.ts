import { createApp } from '@caldera-js/core'
import { queueProvider } from '@caldera-js/queue'
import { bullmqDriver } from '@caldera-js/queue/bullmq'
import { config } from '../.caldera/config.gen.js'
import { env } from './env.js'

export const app = createApp({ env, config, providers: [queueProvider((app) => app.config.queue, { drivers: [bullmqDriver] })] })

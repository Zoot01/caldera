import { defineConfig } from '@caldera/core'

export const app = defineConfig('app', (env) => ({ url: env.APP_URL }))

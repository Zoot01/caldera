import { defineConfig } from '@caldera-js/core'

export const app = defineConfig('app', (env) => ({ url: env.APP_URL }))

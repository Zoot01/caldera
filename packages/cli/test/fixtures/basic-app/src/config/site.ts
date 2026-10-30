import { defineConfig } from '@caldera/core'

export default defineConfig('site', (env) => ({ url: env.APP_URL, port: env.PORT }))

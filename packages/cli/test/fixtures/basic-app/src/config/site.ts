import { defineConfig } from '@caldera-js/core'

export default defineConfig('site', (env) => ({ url: env.APP_URL, port: env.PORT }))

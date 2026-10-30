import { defineConfig } from '@caldera/core'

export const app = defineConfig('app', (env) => ({ out: env.OUT_DIR }))

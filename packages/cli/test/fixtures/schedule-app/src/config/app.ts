import { defineConfig } from '@caldera-js/core'

export const app = defineConfig('app', (env) => ({ out: env.OUT_DIR }))

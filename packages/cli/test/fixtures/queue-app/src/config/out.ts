import { defineConfig } from '@caldera-js/core'

export const out = defineConfig('out', (env) => ({ dir: env.OUT_DIR }))

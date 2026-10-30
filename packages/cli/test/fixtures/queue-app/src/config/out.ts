import { defineConfig } from '@caldera/core'

export const out = defineConfig('out', (env) => ({ dir: env.OUT_DIR }))

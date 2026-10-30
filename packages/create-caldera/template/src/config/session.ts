import { defineConfig } from '@caldera/core'

export const session = defineConfig('session', (env) => ({
  // The first key encrypts; the rest still decrypt, so rotating APP_KEY doesn't drop sessions.
  keys: [env.APP_KEY],
  lifetime: '2h',
}))

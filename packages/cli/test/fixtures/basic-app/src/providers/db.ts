import { defineProvider } from '@caldera/core'

export const dbProvider = defineProvider({
  name: 'db',
  register: (app) => ({
    db: app.singleton(() => {
      throw new Error('describe must never build singletons')
    }),
    databaseUrl: app.config.database.url,
  }),
  request: { requestId: (c) => c.req.header('x-request-id') ?? 'none' },
})

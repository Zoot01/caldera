import { createApp, defineEnv, defineProvider, type HonoEnvOf } from '@caldera-js/core'
import { Hono } from 'hono'
import { expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { createRouter, defineRoutes, errorHandler } from '../src/index.js'

const greeter = defineProvider({
  name: 'greeter',
  register: () => ({ greet: (name: string) => `hello ${name}` }),
  request: { locale: (c) => c.req.header('accept-language') ?? 'en' },
})
const app = createApp({ env: defineEnv({ APP_NAME: z.string().default('demo') }), providers: [greeter] })

// What `caldera generate` writes for a real app.
declare module '@caldera-js/core' {
  interface Register {
    app: typeof app
  }
}

it('gives route handlers the typed Caldera services from c.var', async () => {
  const greetings = defineRoutes('greetings').get('show', '/hello/:name', (c) => {
    expectTypeOf(c.var.greet).toEqualTypeOf<(name: string) => string>()
    expectTypeOf(c.var.locale).toEqualTypeOf<string>()
    return c.json({ text: c.var.greet(c.req.param('name')), locale: c.var.locale })
  })
  const http = new Hono<HonoEnvOf<typeof app>>().use(app.middleware()).route('/', createRouter(greetings).app).onError(errorHandler())

  const res = await http.request('/hello/ann', { headers: { 'accept-language': 'fr' } }, {})
  expect(await res.json()).toEqual({ text: 'hello ann', locale: 'fr' })
})

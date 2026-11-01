import { createApp, defineEnv } from '@caldera-js/core'
import { createRouter, defineRequest, defineRoutes, errorHandler } from '@caldera-js/http'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { i18nProvider, type RequestI18n } from '../../src/index.js'
import { messages } from './edge-messages.js'

const i18nOf = (c: Context) => (c.var as { i18n: RequestI18n }).i18n
const app = createApp({ env: defineEnv({}), providers: [i18nProvider(() => ({ defaultLocale: 'en', locales: ['en', 'fr'] }), { messages })] })
const routes = defineRoutes('edge')
  .get('hello', '/', (c) => {
    const i18n = i18nOf(c)
    return c.json({ locale: i18n.locale, count: i18n.t('posts.count', { count: 1200 }), date: i18n.date(Date.UTC(2026, 9, 30), { dateStyle: 'long', timeZone: 'UTC' }), money: i18n.currency(9.5, 'EUR') })
  })
  .post('store', '/', { request: defineRequest({ body: z.object({ title: z.string().min(3) }) }) }, (c) => c.json(c.req.valid('json')))

export default new Hono().use(app.middleware()).route('/', createRouter(routes).app).onError(errorHandler())

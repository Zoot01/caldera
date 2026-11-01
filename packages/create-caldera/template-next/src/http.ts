import { broadcastRoutes } from '@caldera-js/broadcast'
import { errorHandler, notFoundHandler, originCheck, securityHeaders, startSession, trustProxies } from '@caldera-js/http'
import { mailPreviewRoutes } from '@caldera-js/mail'
import { cronRoutes } from '@caldera-js/schedule'
import { storageRoutes } from '@caldera-js/storage'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen.js'
import { app } from './app.js'

/**
 * The API, mounted by app/api/[[...route]]/route.ts at /api: security defaults, Caldera services on
 * c.var, the session, then your routes. Next renders the pages.
 */
export const http = new Hono()
  .basePath('/api')
  // Next sets its own CSP for pages; these are JSON responses.
  .use(securityHeaders({ csp: false }))
  .use(originCheck())
  .use(app.middleware())
  // Behind a proxy: the client's address (c.var.ip, for rate limits) and HTTPS, from the proxies
  // you trust (TRUSTED_PROXIES in .env).
  .use(trustProxies({ proxies: (c) => c.var.config.app.trustedProxies }))
  .use(startSession())
  // Vercel Cron calls /api/_caldera/cron; it's refused until CRON_SECRET is set.
  .route('/', cronRoutes({ secret: () => app.config.app.cronSecret }))
  // Signed file links for the local disk (/_caldera/files, rewritten here by next.config.ts).
  .route('/', storageRoutes())
  // Browsers ask here before joining a private or presence channel: /api/_caldera/broadcast/auth.
  .route('/', broadcastRoutes())
  // Mail previews and the outbox, outside production only: /_caldera/mail.
  .route('/', mailPreviewRoutes({ enabled: () => process.env.NODE_ENV !== 'production' }))
  .route('/', router.app)
  .onError(errorHandler())
  .notFound(notFoundHandler())

/** For the typed client in client components: `createClient<AppType>()`. A type only. */
export type AppType = typeof router.app

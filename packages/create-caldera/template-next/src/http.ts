import { broadcastRoutes } from '@caldera/broadcast'
import { errorHandler, notFoundHandler, originCheck, securityHeaders, startSession } from '@caldera/http'
import { mailPreviewRoutes } from '@caldera/mail'
import { cronRoutes } from '@caldera/schedule'
import { storageRoutes } from '@caldera/storage'
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

import { broadcastRoutes } from '@caldera-js/broadcast'
import { errorHandler, notFoundHandler, originCheck, securityHeaders, startSession, trustProxies } from '@caldera-js/http'
import { mailPreviewRoutes } from '@caldera-js/mail'
import { cronRoutes } from '@caldera-js/schedule'
import { storageRoutes, uploadRoutes } from '@caldera-js/storage'
import { errorPage } from '@caldera-js/inertia'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen.js'
import { app } from './app.js'
import { inertia } from './inertia.js'
import { uploads } from './uploads.js'

/** The HTTP app: security defaults, Caldera services on c.var, the session, pages, then your routes. */
export const http = new Hono()
  .use(securityHeaders())
  .use(originCheck())
  .use(app.middleware())
  // Behind a proxy: the client's address (c.var.ip, for rate limits) and HTTPS, from the proxies
  // you trust (TRUSTED_PROXIES in .env).
  .use(trustProxies({ proxies: (c) => c.var.config.app.trustedProxies }))
  .use(startSession())
  .use(inertia.middleware())
  // Vercel Cron (and other HTTP crons) call /_caldera/cron; it's refused until CRON_SECRET is set.
  .route('/', cronRoutes({ secret: () => app.config.app.cronSecret }))
  // Signed file links and uploads for the local disk, and direct uploads (src/uploads.ts).
  .route('/', storageRoutes())
  .route('/', uploadRoutes({ uploads }))
  // Browsers ask here before joining a private or presence channel (src/channels decides).
  .route('/', broadcastRoutes())
  // Mail previews and the outbox, outside production only.
  .route('/', mailPreviewRoutes({ enabled: () => process.env.NODE_ENV !== 'production' }))
  .route('/', router.app)
  // People get resources/pages/Error.tsx (with the status); API clients get the JSON error.
  .onError(errorHandler({ page: errorPage() }))
  .notFound(notFoundHandler({ page: errorPage() }))

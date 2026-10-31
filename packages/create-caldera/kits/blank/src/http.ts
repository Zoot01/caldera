import { broadcastRoutes } from '@caldera/broadcast'
import { errorHandler, notFoundHandler, originCheck, securityHeaders, startSession } from '@caldera/http'
import { mailPreviewRoutes } from '@caldera/mail'
import { cronRoutes } from '@caldera/schedule'
import { storageRoutes, uploadRoutes } from '@caldera/storage'
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
  .use(startSession())
  .use(inertia.middleware())
  // Vercel Cron (and other HTTP crons) call /_caldera/cron; it's refused until CRON_SECRET is set.
  .route('/', cronRoutes({ secret: () => app.config.app.cronSecret }))
  // Signed file links and uploads for the local disk, and direct uploads (src/uploads.ts).
  .route('/', storageRoutes())
  .route('/', uploadRoutes({ uploads, secret: () => app.config.storage.uploadSecret }))
  // Browsers ask here before joining a private or presence channel (src/channels decides).
  .route('/', broadcastRoutes())
  // Mail previews and the outbox, outside production only.
  .route('/', mailPreviewRoutes({ enabled: () => process.env.NODE_ENV !== 'production' }))
  .route('/', router.app)
  .onError(errorHandler())
  .notFound(notFoundHandler())

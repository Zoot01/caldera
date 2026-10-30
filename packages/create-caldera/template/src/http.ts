import { errorHandler, notFoundHandler, originCheck, securityHeaders, startSession } from '@caldera/http'
import { cronRoutes } from '@caldera/schedule'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen.js'
import { app } from './app.js'
import { inertia } from './inertia.js'

/** The HTTP app: security defaults, Caldera services on c.var, the session, pages, then your routes. */
export const http = new Hono()
  .use(securityHeaders())
  .use(originCheck())
  .use(app.middleware())
  .use(startSession())
  .use(inertia.middleware())
  // Vercel Cron (and other HTTP crons) call /_caldera/cron; it's refused until CRON_SECRET is set.
  .route('/', cronRoutes({ secret: () => app.config.app.cronSecret }))
  .route('/', router.app)
  .onError(errorHandler())
  .notFound(notFoundHandler())

import { errorHandler, notFoundHandler, originCheck, securityHeaders } from '@caldera/http'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen.js'
import { app } from './app.js'

/** The HTTP app: security defaults, Caldera services on c.var, then your routes. */
export const http = new Hono()
  .use(securityHeaders())
  .use(originCheck())
  .use(app.middleware())
  .route('/', router.app)
  .onError(errorHandler())
  .notFound(notFoundHandler())

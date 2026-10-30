import { errorHandler, notFoundHandler, originCheck } from '@caldera/http'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen.js'
import { app } from './app.js'

export const http = new Hono().use(originCheck()).use(app.middleware()).route('/', router.app).onError(errorHandler()).notFound(notFoundHandler())

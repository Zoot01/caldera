import { defineRoutes } from '@caldera-js/http'
import { mw } from '../middleware.js'

export const dashboard = defineRoutes('dashboard').get('index', '/dashboard', { middleware: [mw.auth(), mw.verified()] }, (c) => c.render('Dashboard', {}))

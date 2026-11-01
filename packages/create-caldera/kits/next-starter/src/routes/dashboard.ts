import { defineRoutes } from '@caldera/http'
import { mw } from '../route-middleware'

export const dashboard = defineRoutes('dashboard').get('index', '/dashboard', { middleware: [mw.auth(), mw.verified()] }, (c) => c.json({}))

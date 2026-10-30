import { defineRoutes } from '@caldera/http'

export default defineRoutes('health').get('check', '/health', (c) => c.text('ok'))

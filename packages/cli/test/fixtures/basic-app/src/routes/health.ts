import { defineRoutes } from '@caldera-js/http'

export default defineRoutes('health').get('check', '/health', (c) => c.text('ok'))

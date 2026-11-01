import { defineRoutes } from '@caldera/http'

// Your API, under /api (src/http.ts). Client components call it with the typed client:
// `createClient<AppType>()` from @caldera/next/client.
export const home = defineRoutes('home').get('hello', '/hello', (c) => c.json({ message: 'Hello from Caldera.' }))

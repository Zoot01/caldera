import { defineRoutes } from '@caldera/http'
import { User } from '../models/user.js'

// Mounted under /api (src/http.ts). Client components call these with the typed client (app/hello.tsx).
export const home = defineRoutes('home')
  .get('hello', '/hello', (c) => c.json({ message: c.var.i18n.t('home.running') }))
  .get('users', '/users', async (c) => c.json({ users: await User.findMany() }))

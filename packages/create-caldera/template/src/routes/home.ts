import { defineRoutes } from '@caldera/http'
import { User } from '../models/user.js'

export const home = defineRoutes('home')
  .get('index', '/', (c) => c.json({ app: c.var.db ? 'ready' : 'no database', docs: 'https://caldera.dev' }))
  .get('users', '/users', async (c) => c.json({ users: await User.findMany() }))

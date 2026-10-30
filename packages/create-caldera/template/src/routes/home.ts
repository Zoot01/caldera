import { defineRoutes } from '@caldera/http'
import { User } from '../models/user.js'

export const home = defineRoutes('home')
  // A page: its props come straight from the route, typed by resources/pages/Home.tsx.
  .get('index', '/', (c) => c.render('Home', { message: 'Your app is running.' }))
  // JSON works the same as in any Hono app.
  .get('users', '/users', async (c) => c.json({ users: await User.findMany() }))

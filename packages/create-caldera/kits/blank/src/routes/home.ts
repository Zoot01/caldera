import { defineRoutes } from '@caldera-js/http'
import { User } from '../models/user.js'

export const home = defineRoutes('home')
  // A page: its props come straight from the route, typed by resources/pages/Home.tsx.
  // c.var.i18n translates in the visitor's locale; keys and parameters are typed from lang/en.
  .get('index', '/', (c) => c.render('Home', { message: c.var.i18n.t('home.running') }))
  // JSON works the same as in any Hono app.
  .get('users', '/users', async (c) => c.json({ users: await User.findMany() }))

import { defineRoutes } from '@caldera/http'

export const home = defineRoutes('home')
  // The welcome page: its props come straight from the route, typed by resources/pages/Home.tsx.
  // c.var.i18n translates in the visitor's locale; keys and parameters are typed from lang/en.
  .get('index', '/', (c) => c.render('Home', { message: c.var.i18n.t('home.running') }))

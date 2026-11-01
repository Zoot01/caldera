import { defineRoutes } from '@caldera-js/http'

export const home = defineRoutes('home')
  // The welcome page (resources/pages/Home.tsx). A page's props come straight from its route, typed
  // by the page: c.render('Home', {}) fails to typecheck if the page asks for something.
  .get('index', '/', (c) => c.render('Home', {}))

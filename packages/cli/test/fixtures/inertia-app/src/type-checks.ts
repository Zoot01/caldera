// Compile-time only: these lines type-check only once `caldera generate` registers pages and shared props.
import { defineRoutes } from '@caldera/http'

export const wrong = defineRoutes('wrong')
  // @ts-expect-error not a page in resources/pages
  .get('missing', '/missing', (c) => c.render('Nope', {}))
  // @ts-expect-error greeting must be a string
  .get('bad', '/bad', (c) => c.render('Home', { greeting: 1 }))

import { defer } from '@caldera-js/inertia'
import { defineRoutes } from '@caldera-js/http'

export const pages = defineRoutes('pages')
  .get('home', '/', (c) => c.render('Home', { greeting: 'hi' }))
  .get('posts', '/posts', (c) => c.render('Posts/Index', { posts: async () => [{ id: 1, title: 'Hello' }], stats: defer(async () => ({ total: 1 })) }))

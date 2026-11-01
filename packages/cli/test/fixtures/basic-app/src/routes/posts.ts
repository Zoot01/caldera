import { allows } from '@caldera-js/auth'
import { defineRoutes } from '@caldera-js/http'
import Post from '../models/post.js'

export const posts = defineRoutes('posts', { prefix: '/posts' })
  .get('index', '/', (c) => c.json({ db: c.var.databaseUrl }))
  .get('show', '/:post', { bind: { post: Post }, authorize: allows(Post, 'view', 'post') }, (c) => c.json({ id: c.var.post.id }))

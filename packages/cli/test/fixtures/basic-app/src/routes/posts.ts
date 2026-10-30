import { defineRequest, defineRoutes } from '@caldera/http'
import { z } from 'zod'

const ShowPost = defineRequest({ params: z.object({ post: z.coerce.number() }) })

export const posts = defineRoutes('posts', { prefix: '/posts' })
  .get('index', '/', (c) => c.json({ db: c.var.databaseUrl }))
  .get('show', '/:post', { request: ShowPost }, (c) => c.json({ id: c.req.valid('param').post }))

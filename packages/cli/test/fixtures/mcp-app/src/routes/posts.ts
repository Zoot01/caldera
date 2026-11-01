import { defaultDatabase } from '@caldera-js/db'
import { defineRequest, defineRoutes } from '@caldera-js/http'
import { z } from 'zod'
import { posts as table } from '../db/schema.js'

const Store = defineRequest({ body: z.object({ title: z.string().min(3) }) })

export const posts = defineRoutes('posts', { prefix: '/posts' })
  .get('index', '/', async (c) => {
    // Printed by the app; must never reach the MCP protocol stream.
    console.log('listing posts')
    return c.json({ posts: await defaultDatabase().client.select().from(table) })
  })
  .post('store', '/', { request: Store }, async (c) => {
    const [post] = await defaultDatabase().client.insert(table).values(c.req.valid('json')).returning()
    return c.json({ post }, 201)
  })
  .get('boom', '/boom', () => {
    throw new Error('kaboom')
  })

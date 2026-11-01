import type {} from '@libsql/client'
import { cacheProvider } from '@caldera-js/cache'
import { createApp, defineEnv } from '@caldera-js/core'
import { databaseProvider, defaultDatabase } from '@caldera-js/db'
import { back, defineRequest, defineRoutes, createRouter, errorHandler, notFoundHandler, originCheck, sessionProvider, startSession } from '@caldera-js/http'
import { defineInertia } from '@caldera-js/inertia'
import { createMail, mailProvider } from '@caldera-js/mail'
import { defineRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Hono } from 'hono'
import { z } from 'zod'

export const posts = sqliteTable('posts', { id: integer('id').primaryKey({ autoIncrement: true }), title: text('title').notNull() })
const relations = defineRelations({ posts })

// Not a generated app, so app.env isn't typed through register.d.ts.
type Env = { DATABASE_URL: string; APP_KEY: string }

export const app = createApp({
  env: defineEnv({ DATABASE_URL: z.string(), APP_KEY: z.string().min(32), NODE_ENV: z.string() }),
  providers: [
    databaseProvider({ driver: 'sqlite', connect: (app) => drizzle({ connection: { url: (app.env as unknown as Env).DATABASE_URL }, relations }) }),
    sessionProvider((app) => ({ keys: [(app.env as unknown as Env).APP_KEY] })),
    mailProvider(() => ({ default: 'memory', mailers: { memory: { driver: 'memory' } }, from: 'app@example.test' })),
    cacheProvider(() => ({ default: 'memory', stores: { memory: { driver: 'memory' } } })),
  ],
})
export { createMail }

const StorePost = defineRequest({ body: z.object({ title: z.string().min(3) }) })
const StoreForm = defineRequest({ form: z.object({ title: z.string().min(3) }) })
// Through current(): it joins the transaction a test runs in, as models do.
const all = () => defaultDatabase().current().select().from(posts)
const inertia = defineInertia({ version: 'v1', share: () => ({ appName: 'fixture' }) })

const api = defineRoutes('api', { prefix: '/api' })
  .get('index', '/posts', async (c) => c.json({ posts: await all() }))
  .post('store', '/posts', { request: StorePost }, async (c) => {
    const [post] = await defaultDatabase().current().insert(posts).values(c.req.valid('json')).returning()
    return c.json({ post }, 201)
  })
  // Bytes that aren't valid UTF-8, as an image or a zip would be.
  .get('download', '/download', (c) =>
    c.body(new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00]), 200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="r_sum_.bin"; filename*=UTF-8''${encodeURIComponent('résumé.bin')}` }),
  )
const web = defineRoutes('web')
  .get('index', '/posts', async (c) => c.render('Posts/Index' as never, { posts: await all() } as never))
  .get('create', '/posts/create', (c) => c.render('Posts/Create' as never, {} as never))
  .post('store', '/posts', { request: StoreForm }, async (c) => {
    await defaultDatabase().current().insert(posts).values(c.req.valid('form'))
    return back(c).with('success', 'Created.')
  })

export const http = new Hono()
  .use(originCheck())
  .use(app.middleware())
  .use(startSession())
  .use(inertia.middleware())
  .route('/', createRouter(api, web).app)
  .onError(errorHandler())
  .notFound(notFoundHandler())

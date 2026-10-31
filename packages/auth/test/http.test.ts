import { createApp, defineEnv, type HonoEnvOf } from '@caldera/core'
import type { Row } from '@caldera/db'
import { createRouter, defineMiddleware, defineRoutes, errorHandler, type ErrorBody } from '@caldera/http'
import { Hono } from 'hono'
import { beforeEach, expect, it } from 'vitest'
import { allows, authorizationProvider, definePolicy } from '../src/index.js'
import { Post, PostPolicy, setup, User } from './fixtures.js'

let s: Awaited<ReturnType<typeof setup>>
beforeEach(async () => {
  s = await setup()
})

// Stand-in for the Better Auth middleware: the user id comes from a header.
const mw = defineMiddleware({
  auth: () => async (c, next) => {
    const id = c.req.header('x-user')
    c.set('user' as never, (id ? await User.find(id) : null) as never)
    await next()
  },
})

it('authorizes routes against policies after binding, with standard error responses', async () => {
  const app = createApp({ env: defineEnv({}), providers: [authorizationProvider()] })
  const routes = defineRoutes('posts', { prefix: '/posts', middleware: [mw.auth()] })
    .get('show', '/:post', { bind: { post: Post }, authorize: allows(Post, 'view', 'post') }, (c) => c.json({ slug: c.var.post.slug }))
    .delete('destroy', '/:post', { bind: { post: Post }, authorize: allows(Post, 'delete', 'post') }, async (c) => {
      await Post.delete(c.var.post)
      return c.body(null, 204)
    })
  const http = new Hono<HonoEnvOf<typeof app>>().use(app.middleware()).route('/', createRouter(routes).app).onError(errorHandler())
  const call = async (method: string, path: string, user?: Row<typeof User>) => {
    const res = await http.request(path, { method, headers: user ? { 'x-user': user.id } : {} }, {})
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as ErrorBody & { slug?: string }) }
  }

  expect(await call('GET', '/posts/live')).toMatchObject({ status: 200, body: { slug: 'live' } })
  expect((await call('GET', '/posts/draft')).status).toBe(404) // hidden from guests
  expect(await call('GET', '/posts/draft', s.ann)).toMatchObject({ status: 200 })

  expect((await call('DELETE', '/posts/draft')).body?.error).toMatchObject({ code: 'unauthenticated', status: 401 })
  expect((await call('DELETE', '/posts/draft', s.bob)).body?.error).toMatchObject({ code: 'not_found', status: 404 })
  expect((await call('DELETE', '/posts/draft', s.ann)).status).toBe(204)
  expect(await Post.find(s.draft.id)).toBeUndefined()
})

it('registers the policies it is given, so they apply even if nothing else imported them', async () => {
  // Another policy for posts took over the registry (a stale module, say); the app's list wins.
  definePolicy(Post, { view: () => false })
  const app = createApp({ env: defineEnv({}), providers: [authorizationProvider({ policies: [PostPolicy] })] })
  const routes = defineRoutes('posts', { prefix: '/posts', middleware: [mw.auth()] }).get('show', '/:post', { bind: { post: Post }, authorize: allows(Post, 'view', 'post') }, (c) => c.json({ slug: c.var.post.slug }))
  const http = new Hono<HonoEnvOf<typeof app>>().use(app.middleware()).route('/', createRouter(routes).app).onError(errorHandler())
  expect((await http.request('/posts/live', {}, {})).status).toBe(200)
})

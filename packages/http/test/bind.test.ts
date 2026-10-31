import { Hono, type MiddlewareHandler } from 'hono'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { createRouter, defineMiddleware, defineRequest, defineRoutes, errorHandler, type RouteContext } from '../src/index.js'

interface Post {
  id: number
  slug: string
  teamId: number
}
const rows: Post[] = [
  { id: 1, slug: 'hello', teamId: 1 },
  { id: 2, slug: 'secret', teamId: 2 },
]
const PostModel = { name: 'post', findByRouteKey: async (slug: string) => rows.find((r) => r.slug === slug) }

const order: string[] = []
const step =
  (label: string): MiddlewareHandler =>
  async (_c, next) => {
    order.push(label)
    await next()
  }
const mw = defineMiddleware({ auth: () => step('auth') })

const posts = defineRoutes('posts', { prefix: '/posts' })
  .get('show', '/:post', { bind: { post: PostModel } }, (c) => {
    expectTypeOf(c.var.post).toEqualTypeOf<Post>()
    return c.json({ id: c.var.post.id })
  })
  .put(
    'update',
    '/:post',
    {
      middleware: [mw.auth()],
      request: defineRequest({ authorize: () => (order.push('authorize'), true) }),
      // A scoped binding: only posts in the caller's team are visible (it gets the request's c).
      bind: { post: async (slug: string, c: RouteContext) => rows.find((r) => r.slug === slug && r.teamId === Number(c.req.header('x-team') ?? 1)) },
    },
    (c) => {
      order.push('handler')
      return c.json({ id: c.var.post.id })
    },
  )

const app = new Hono().route('/', createRouter(posts).app).onError(errorHandler())

describe('route model binding', () => {
  it('loads the bound row into c.var', async () => {
    expect(await (await app.request('/posts/hello')).json()).toEqual({ id: 1 })
  })

  it('404s with the standard envelope when nothing matches', async () => {
    const res = await app.request('/posts/missing')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'not_found', message: 'Not found.' } })
  })

  it('supports scoped lookups and runs between auth and authorize', async () => {
    order.length = 0
    const bindProbe = { name: 'probe', findByRouteKey: async (slug: string) => (order.push('bind'), rows.find((r) => r.slug === slug)) }
    const probed = defineRoutes('probe').put(
      'update',
      '/probe/:post',
      { middleware: [mw.auth()], request: defineRequest({ authorize: () => (order.push('authorize'), true) }), bind: { post: bindProbe } },
      (c) => (order.push('handler'), c.json({ id: c.var.post.id })),
    )
    await new Hono().route('/', probed.app).request('/probe/hello', { method: 'PUT' })
    expect(order).toEqual(['auth', 'bind', 'authorize', 'handler'])

    expect((await app.request('/posts/hello', { method: 'PUT' })).status).toBe(200)
    expect((await app.request('/posts/secret', { method: 'PUT' })).status).toBe(404)
    // The binding reads the request: team 2 sees its own post.
    expect((await app.request('/posts/secret', { method: 'PUT', headers: { 'x-team': '2' } })).status).toBe(200)
  })

  it('appears in the manifest and rejects bindings without a matching parameter', () => {
    const show = createRouter(posts).manifest().routes.find((r) => r.name === 'posts.show')!
    expect(show.bindings).toEqual({ post: 'post' })
    expect(show.middleware.map((m) => m.name)).toEqual(['bind'])
    expect(() => defineRoutes('bad').get('x', '/things/:id', { bind: { post: PostModel } }, (c) => c.text(''))).toThrow(/no :post parameter/)
  })
})

it('types a helper that takes a route’s c (RouteContext)', async () => {
  const slugOf = (c: RouteContext<{ post: typeof PostModel }>) => `${c.var.post.slug}:${c.req.param('post')}`
  const group = defineRoutes('typed', { prefix: '/typed' }).put(
    'update',
    '/:post/:other',
    { bind: { post: PostModel, other: PostModel }, request: defineRequest({ body: z.object({ title: z.string() }) }) },
    // A route with more bindings and a request body still passes its c.
    (c) => c.text(slugOf(c)),
  )
  const res = await group.app.request('/typed/hello/secret', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })
  expect(await res.text()).toBe('hello:hello')
})

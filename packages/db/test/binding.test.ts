import { createRouter, defineRoutes, errorHandler } from '@caldera/http'
import { Hono } from 'hono'
import { beforeEach, expect, expectTypeOf, it } from 'vitest'
import type { Row } from '../src/index.js'
import { Post, setupDatabase, User } from './model-fixtures.js'

beforeEach(async () => {
  await setupDatabase()
})

it('binds real models by route key, with hidden columns excluded and soft-deleted rows 404ing', async () => {
  const ann = await User.forceCreate({ name: 'Ann', email: 'ann@example.test', passwordHash: 'x' })
  const post = await Post.forceCreate({ title: 'Bound Post', slug: '', authorId: ann.id, internalNotes: 'private' })

  const routes = defineRoutes('posts', { prefix: '/posts' }).get('show', '/:post', { bind: { post: Post } }, (c) => {
    expectTypeOf(c.var.post).toEqualTypeOf<Row<typeof Post>>()
    return c.json(Post.serialize(c.var.post))
  })
  const app = new Hono().route('/', createRouter(routes).app).onError(errorHandler())

  const res = await app.request('/posts/bound-post')
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, unknown>
  expect(body).toMatchObject({ id: post.id, slug: 'bound-post', excerpt: '' })
  expect(body).not.toHaveProperty('internalNotes')

  await Post.delete(post)
  expect((await app.request('/posts/bound-post')).status).toBe(404)
})

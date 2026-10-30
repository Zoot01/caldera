import { PGlite } from '@electric-sql/pglite'
import { createApp, defineEnv, type HonoEnvOf } from '@caldera/core'
import { databaseProvider, type Row } from '@caldera/db'
import { createRouter, defineMiddleware, defineRoutes, errorHandler, type ErrorBody } from '@caldera/http'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { allows, authenticate, authorizationProvider, authRoutes, betterAuthProvider } from '../src/index.js'
import { account, Post, relations, SCHEMA_SQL, session, User, users, verification } from './fixtures.js'

const ORIGIN = 'http://localhost:3000'
const mw = defineMiddleware({ auth: (options?: { required?: boolean }) => authenticate(options) })

function makeApp(client: PGlite) {
  return createApp({
    env: defineEnv({}),
    providers: [
      databaseProvider({ driver: 'postgres', connect: () => drizzle({ client, relations }) }),
      betterAuthProvider({
        userModel: User,
        create: ({ db }) =>
          betterAuth({
            baseURL: ORIGIN,
            secret: 'test-secret-0123456789-abcdefghijklmnop',
            logger: { disabled: true },
            database: drizzleAdapter(db as never, { provider: 'pg', schema: { users, session, account, verification } }),
            user: { modelName: 'users', additionalFields: { plan: { type: 'string', required: false, defaultValue: 'free', input: false } } },
            advanced: { database: { generateId: 'uuid' } },
            emailAndPassword: { enabled: true },
          }),
      }),
      authorizationProvider(),
    ],
  })
}

// What `caldera generate` writes for a real app, so route handlers see typed c.var services.
declare module '@caldera/core' {
  interface Register {
    app: ReturnType<typeof makeApp>
  }
}

async function makeServer() {
  const client = new PGlite()
  await client.exec(SCHEMA_SQL)
  const app = makeApp(client)

  const me = defineRoutes('me')
    .get('show', '/me', { middleware: [mw.auth()] }, (c) => {
      expectTypeOf(c.var.user).toEqualTypeOf<Row<typeof User> | null>()
      return c.json({ email: c.var.user!.email, plan: c.var.user!.plan })
    })
    .get('optional', '/whoami', { middleware: [mw.auth({ required: false })] }, (c) => c.json({ user: c.var.user?.email ?? null }))
  const posts = defineRoutes('posts').post('store', '/posts', { middleware: [mw.auth()], authorize: allows(Post, 'create') }, async (c) => {
    const post = await Post.create({ slug: `p-${Date.now()}`, authorId: c.var.user!.id })
    return c.json({ id: post.id }, 201)
  })

  const http = new Hono<HonoEnvOf<typeof app>>().use(app.middleware()).route('/', authRoutes()).route('/', createRouter(me, posts).app).onError(errorHandler())
  return { http, client }
}

let server: Awaited<ReturnType<typeof makeServer>>
beforeEach(async () => {
  server = await makeServer()
})

async function call(method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN }
  if (options.cookie) headers.cookie = options.cookie
  if (options.body) headers['content-type'] = 'application/json'
  const res = await server.http.request(`${ORIGIN}${path}`, { method, headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) }, {})
  const text = await res.text()
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: text ? (JSON.parse(text) as Record<string, any>) : null }
}

async function signUp(email = 'ann@example.test') {
  const res = await call('POST', '/api/auth/sign-up/email', { body: { name: 'Ann', email, password: 'correct-horse-battery' } })
  expect(res.status).toBe(200)
  return res.cookie!
}

describe('Better Auth integration', () => {
  it('signs up into the app-owned users table and exposes the typed user on c.var', async () => {
    expect((await call('GET', '/me')).body?.error).toMatchObject({ code: 'unauthenticated', status: 401 })
    const cookie = await signUp()
    expect(await call('GET', '/me', { cookie })).toMatchObject({ status: 200, body: { email: 'ann@example.test', plan: 'free' } })
    const row = (await server.client.query<{ id: string }>(`select id from users where email = 'ann@example.test'`)).rows[0]!
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/) // Better Auth used the uuid column
  })

  it('treats a missing session as a guest on optional routes', async () => {
    expect((await call('GET', '/whoami')).body).toEqual({ user: null })
    expect((await call('GET', '/whoami', { cookie: await signUp() })).body).toEqual({ user: 'ann@example.test' })
  })

  it('applies policies to the signed-in user', async () => {
    const cookie = await signUp()
    const denied = await call('POST', '/posts', { cookie })
    expect((denied.body as ErrorBody).error).toMatchObject({ code: 'forbidden', status: 403, message: 'Upgrade to publish.' })

    await server.client.query(`update users set plan = 'pro'`)
    expect((await call('POST', '/posts', { cookie })).status).toBe(201)
  })

  it('signs out, and ignores sessions of users that no longer exist', async () => {
    const cookie = await signUp()
    expect((await call('POST', '/api/auth/sign-out', { cookie, body: {} })).status).toBe(200)
    expect((await call('GET', '/me', { cookie })).status).toBe(401)

    const other = await signUp('bob@example.test')
    await server.client.query(`delete from users where email = 'bob@example.test'`)
    expect((await call('GET', '/me', { cookie: other })).status).toBe(401)
  })
})

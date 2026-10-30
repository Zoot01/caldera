import { PGlite } from '@electric-sql/pglite'
import { createApp, defineEnv, type HonoEnvOf } from '@caldera/core'
import { databaseProvider, type Row } from '@caldera/db'
import { createRouter, defineMiddleware, defineRoutes, errorHandler, originCheck, sessionProvider, startSession, type ErrorBody } from '@caldera/http'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { allows, authenticate, authorizationProvider, authRoutes, betterAuthProvider } from '../src/index.js'
import { account, Post, relations, SCHEMA_SQL, session, User, users, verification } from './fixtures.js'

const ORIGIN = 'http://localhost:3000'
const ADMIN_ORIGIN = 'https://admin.example.test'
const TRUSTED = [ORIGIN, ADMIN_ORIGIN]
const mw = defineMiddleware({ auth: (options?: { required?: boolean }) => authenticate(options) })

function makeApp(client: PGlite) {
  return createApp({
    env: defineEnv({}),
    providers: [
      databaseProvider({ driver: 'postgres', connect: () => drizzle({ client, relations }) }),
      betterAuthProvider({
        userModel: User,
        trustedOrigins: TRUSTED,
        create: ({ db, trustedOrigins }) =>
          betterAuth({
            baseURL: ORIGIN,
            trustedOrigins,
            secret: 'test-secret-0123456789-abcdefghijklmnop',
            logger: { disabled: true },
            database: drizzleAdapter(db as never, { provider: 'pg', schema: { users, session, account, verification } }),
            user: { modelName: 'users', additionalFields: { plan: { type: 'string', required: false, defaultValue: 'free', input: false } } },
            advanced: { database: { generateId: 'uuid' } },
            emailAndPassword: { enabled: true },
          }),
      }),
      authorizationProvider(),
      sessionProvider(() => ({ keys: ['app-key-0123456789-0123456789-01234'] })),
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
    .post('remember', '/remember', (c) => {
      c.var.session.put('cart', ['book'])
      return c.json({ ok: true })
    })
    .get('recall', '/recall', (c) => c.json({ cart: c.var.session.get('cart') ?? null }))
  const posts = defineRoutes('posts').post('store', '/posts', { middleware: [mw.auth()], authorize: allows(Post, 'create') }, async (c) => {
    const post = await Post.create({ slug: `p-${Date.now()}`, authorId: c.var.user!.id })
    return c.json({ id: post.id }, 201)
  })

  const http = new Hono<HonoEnvOf<typeof app>>()
    .use(originCheck({ trustedOrigins: TRUSTED }))
    .use(app.middleware())
    .use(startSession())
    .route('/', authRoutes()).route('/', createRouter(me, posts).app).onError(errorHandler())
  return { http, client, app }
}

let server: Awaited<ReturnType<typeof makeServer>>
beforeEach(async () => {
  server = await makeServer()
})

async function call(method: string, path: string, options: { cookie?: string; body?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = { origin: options.origin ?? ORIGIN }
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

describe('the app session', () => {
  /** Keeps both cookies, like a browser. */
  function jar() {
    const cookies = new Map<string, string>()
    return async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { origin: ORIGIN, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
      if (body) headers['content-type'] = 'application/json'
      const res = await server.http.request(`${ORIGIN}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }, {})
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(';')
        const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)]
        if (value === '' || /max-age=0/i.test(cookie)) cookies.delete(name)
        else cookies.set(name, value)
      }
      return { res, json: async () => (await res.json()) as Record<string, unknown>, appCookie: () => cookies.get('caldera_session') }
    }
  }

  it('is reissued on sign-in and cleared on sign-out', async () => {
    const send = jar()
    await send('POST', '/remember')
    const before = (await send('GET', '/recall')).appCookie()
    const signedUp = await send('POST', '/api/auth/sign-up/email', { name: 'Ann', email: 'ann@example.test', password: 'correct-horse-battery' })
    expect(signedUp.res.status).toBe(200)
    // A fresh cookie value, same data: nothing from before sign-in is lost.
    expect(signedUp.appCookie()).not.toBe(before)
    expect(await (await send('GET', '/recall')).json()).toEqual({ cart: ['book'] })

    const signedOut = await send('POST', '/api/auth/sign-out', {})
    expect(signedOut.res.status).toBe(200)
    expect(signedOut.appCookie()).toBeUndefined()
    expect(await (await send('GET', '/recall')).json()).toEqual({ cart: null })
  })
})

describe('trusted origins', () => {
  const signUpFrom = (origin: string) =>
    call('POST', '/api/auth/sign-up/email', { origin, body: { name: 'Cy', email: `cy-${origin.length}@example.test`, password: 'correct-horse-battery' } })

  it('lets both layers accept the same trusted origins and reject others', async () => {
    expect((await signUpFrom(ADMIN_ORIGIN)).status).toBe(200)
    const blocked = await signUpFrom('https://evil.test')
    expect(blocked.status).toBe(403)
    expect(blocked.body?.error).toMatchObject({ code: 'csrf_failed' })
  })

  it('refuses to start Better Auth with a different list', async () => {
    const client = new PGlite()
    const app = createApp({
      env: defineEnv({}),
      providers: [
        databaseProvider({ driver: 'postgres', connect: () => drizzle({ client, relations }) }),
        betterAuthProvider({
          trustedOrigins: TRUSTED,
          create: ({ db }) =>
            betterAuth({
              baseURL: ORIGIN,
              secret: 'test-secret-0123456789-abcdefghijklmnop',
              logger: { disabled: true },
              database: drizzleAdapter(db as never, { provider: 'pg', schema: { users, session, account, verification } }),
              trustedOrigins: [ORIGIN],
            }),
        }),
      ],
    })
    await app.boot({ env: {} })
    expect(() => app.services.auth).toThrow(/differ from Caldera's/)
  })
})

describe('sessionCookieFor (actingAs in @caldera/testing)', () => {
  it('signs in as a user through Better Auth’s own sessions, without a password', async () => {
    const { sessionCookieFor } = await import('../src/testing.js')
    const { http, app } = await makeServer()
    const signUp = await http.request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'tess@example.test', password: 'correct horse battery', name: 'Tess' }),
    })
    const { user } = (await signUp.json()) as { user: { id: string } }
    expect(await (await http.request(`${ORIGIN}/whoami`)).json()).toEqual({ user: null })
    // The app's Better Auth instance, as setupApp(app).services.auth gives it.
    const cookie = await sessionCookieFor(app.services.auth, user)
    const res = await http.request(`${ORIGIN}/me`, { headers: { cookie: `${cookie.name}=${cookie.value}` } })
    expect(await res.json()).toMatchObject({ email: 'tess@example.test' })
    await expect(sessionCookieFor(app.services.auth, { id: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/no user with id/)
  })
})

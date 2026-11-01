import { createApp, defineEnv } from '@caldera/core'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  back,
  createRouter,
  createSessionCodec,
  defineRequest,
  defineRoutes,
  errorHandler,
  parseDuration,
  redirect,
  sessionOf,
  sessionProvider,
  startSession,
  trustProxies,
} from '../src/index.js'

const KEY = 'test-key-0123456789-0123456789-0123'
const OLD_KEY = 'old-key-0123456789-0123456789-01234'

function makeApp(keys: string[] = [KEY], cookie: { maxBytes?: number } = {}) {
  const app = createApp({
    env: defineEnv({}),
    providers: [sessionProvider(() => ({ keys, cookie, lifetime: '2h' }))],
  })
  const StorePost = defineRequest({ form: z.object({ title: z.string().min(3, 'Too short'), password: z.string().optional() }) })
  const routes = defineRoutes('demo')
    .get('home', '/', (c) => c.json({ flashed: sessionOf(c).flashed(), errors: sessionOf(c).errors(), old: sessionOf(c).old('title') ?? null }))
    .get('count', '/count', (c) => {
      const count = sessionOf(c).get('count', 0) + 1
      sessionOf(c).put('count', count)
      return c.json({ count })
    })
    .get('static', '/static', (c) => c.text('no session use'))
    .post('save', '/posts', { request: StorePost }, (c) => back(c).with('success', 'Saved'))
    .post('bounce', '/bounce', (c) => {
      sessionOf(c).reflash()
      return redirect(c, '/')
    })
    .get('big', '/big', (c) => {
      sessionOf(c).put('blob', 'x'.repeat(5000))
      return c.text('ok')
    })
  // In a real app, c.var.session is typed once `caldera generate` registers the app; this
  // package's tests register a different app, so they use sessionOf(c).
  const http = new Hono().use(app.middleware()).use(startSession()).route('/', createRouter(routes).app).onError(errorHandler())
  return http
}

/** A tiny browser: keeps the cookie jar between requests. */
function browser(http: ReturnType<typeof makeApp>) {
  let cookie: string | undefined
  return {
    get cookie() {
      return cookie
    },
    set cookie(value) {
      cookie = value
    },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      if (cookie) headers.set('cookie', cookie)
      const res = await http.request(`http://localhost${path}`, { ...init, headers })
      const set = res.headers.get('set-cookie')
      if (set) cookie = /Max-Age=0/.test(set) ? undefined : set.split(';')[0]
      return res
    },
  }
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  body: new URLSearchParams(fields),
  headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'http://localhost/posts/new', ...headers },
})

describe('session', () => {
  it('sets no cookie when nothing is stored, so anonymous pages stay cacheable', async () => {
    const res = await makeApp().request('/static')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('persists values across requests in an encrypted, HttpOnly cookie', async () => {
    const b = browser(makeApp())
    expect(await (await b.request('/count')).json()).toEqual({ count: 1 })
    const res = await b.request('/count')
    expect(await res.json()).toEqual({ count: 2 })
    const header = res.headers.get('set-cookie')!
    expect(header).toMatch(/^caldera_session=[\w-]+; Max-Age=7200; Path=\/; HttpOnly; SameSite=Lax/)
    expect(header).not.toContain('count')
  })

  it('skips the write when the session did not change', async () => {
    const b = browser(makeApp())
    await b.request('/count')
    const res = await b.request('/static')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('ignores a tampered or foreign cookie', async () => {
    const b = browser(makeApp())
    await b.request('/count')
    b.cookie = b.cookie!.slice(0, -2) + (b.cookie!.endsWith('A') ? 'BB' : 'AA')
    expect(await (await b.request('/count')).json()).toEqual({ count: 1 })
  })

  it('still reads cookies sealed with a previous key', async () => {
    const before = browser(makeApp([OLD_KEY]))
    await before.request('/count')
    const after = browser(makeApp([KEY, OLD_KEY]))
    after.cookie = before.cookie
    expect(await (await after.request('/count')).json()).toEqual({ count: 2 })
  })

  it('binds the value to the cookie name', async () => {
    const a = createSessionCodec({ keys: [KEY], cookie: { name: 'a' } })
    const b = createSessionCodec({ keys: [KEY], cookie: { name: 'b' } })
    const http = new Hono().get('/', async (c) => c.text(await a.encode(c, { data: { x: 1 }, flash: {} })))
    const value = (await (await http.request('/')).text()).split(';')[0]!.split('=')[1]!
    expect(await a.decode(value)).toMatchObject({ data: { x: 1 } })
    expect(await b.decode(value)).toBeNull()
  })

  it('fails loudly instead of sending a cookie browsers would drop', async () => {
    const res = await makeApp().request('/big')
    expect(res.status).toBe(500)
  })
})

describe('flash and redirects', () => {
  it('flashes for exactly one request, then clears the cookie', async () => {
    const b = browser(makeApp())
    const saved = await b.request('/posts', form({ title: 'Hello' }))
    expect(saved.status).toBe(303)
    expect(saved.headers.get('location')).toBe('/posts/new')
    expect(await (await b.request('/')).json()).toMatchObject({ flashed: { success: 'Saved' } })
    const second = await b.request('/')
    expect(await second.json()).toMatchObject({ flashed: {} })
    expect(b.cookie).toBeUndefined()
  })

  it('reflash keeps flash data across a second redirect', async () => {
    const b = browser(makeApp())
    await b.request('/posts', form({ title: 'Hello' }))
    expect((await b.request('/bounce', { method: 'POST' })).headers.get('location')).toBe('/')
    expect(await (await b.request('/')).json()).toMatchObject({ flashed: { success: 'Saved' } })
  })

  it('redirects a failed plain form back with errors and old input, never the password', async () => {
    const b = browser(makeApp())
    const res = await b.request('/posts', form({ title: 'Hi', password: 'hunter22' }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/posts/new')
    const page = await (await b.request('/')).json()
    expect(page).toEqual({ flashed: {}, errors: { title: ['Too short'] }, old: 'Hi' })
    expect(JSON.stringify(page)).not.toContain('hunter22')
  })

  it('redirects Inertia visits without old input, into the requested error bag', async () => {
    const b = browser(makeApp())
    const res = await b.request('/posts', form({ title: 'Hi' }, { 'x-inertia': 'true', 'x-inertia-error-bag': 'createPost' }))
    expect(res.status).toBe(303)
    const page = await (await b.request('/')).json()
    expect(page.errors).toEqual({})
    expect(page.old).toBeNull()
  })

  it('keeps the JSON envelope for API clients', async () => {
    const res = await makeApp().request('/posts', form({ title: 'Hi' }, { accept: 'application/json' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: { code: 'validation_failed', fields: { title: ['Too short'] } } })
  })

  it('keeps cookies and headers set before the redirect', async () => {
    const app = new Hono().post('/locale', (c) => {
      setCookie(c, 'locale', 'fr')
      c.header('vary', 'Cookie', { append: true })
      return redirect(c, '/')
    })
    const res = await app.request('/locale', { method: 'POST' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.getSetCookie()).toEqual(['locale=fr; Path=/'])
    expect(res.headers.get('vary')).toBe('Cookie')
  })

  it('never redirects back to another site', async () => {
    const b = browser(makeApp())
    const res = await b.request('/posts', form({ title: 'Hello' }, { referer: 'https://evil.example/' }))
    expect(res.headers.get('location')).toBe('/')
  })
})

it('parses durations', () => {
  expect(parseDuration('90s')).toBe(90)
  expect(parseDuration('2h')).toBe(7200)
  expect(parseDuration(60)).toBe(60)
  expect(() => parseDuration('soon')).toThrow(/duration/)
})

describe('session cookies behind a proxy', () => {
  it('are Secure when a trusted proxy says the visit was over HTTPS, and not otherwise', async () => {
    const app = createApp({ env: defineEnv({}), providers: [sessionProvider(() => ({ keys: [KEY] }))] })
    const http = new Hono()
      .use(trustProxies())
      .use(app.middleware())
      .use(startSession())
      .get('/', (c) => {
        sessionOf(c).put('seen', true)
        return c.text('ok')
      })
    const cookieOf = async (peer: string) =>
      (await http.request('/', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' } }, { incoming: { socket: { remoteAddress: peer } } })).headers.get('set-cookie') ?? ''
    expect(await cookieOf('127.0.0.1')).toMatch(/; Secure/)
    expect(await cookieOf('198.51.100.1')).not.toMatch(/; Secure/)
  })
})


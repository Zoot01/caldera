import { createApp, defineEnv } from '@caldera-js/core'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { errorHandler, intended, INTENDED_KEY, sessionOf, sessionProvider, startSession, UnauthenticatedError } from '../src/index.js'

const KEY = 'test-key-0123456789-0123456789-0123'
const page = { accept: 'text/html,application/xhtml+xml' }

function makeHttp(loginUrl?: string) {
  const app = createApp({ env: defineEnv({}), providers: [sessionProvider(() => ({ keys: [KEY] }))] })
  const guard = () => {
    throw new UnauthenticatedError()
  }
  return new Hono()
    .use(app.middleware())
    .use(startSession())
    .get('/dashboard', guard)
    .post('/posts', guard)
    .get('/login', guard)
    .post('/login', (c) => intended(c, '/home'))
    .post('/plant', (c) => {
      sessionOf(c).put(INTENDED_KEY, c.req.query('to'))
      return c.body(null, 204)
    })
    .onError(errorHandler(loginUrl ? { loginUrl } : {}))
}

function browser(http: ReturnType<typeof makeHttp>) {
  let cookie = ''
  return async (path: string, init: RequestInit = {}) => {
    const res = await http.request(`http://localhost${path}`, { ...init, headers: { ...page, ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return res
  }
}

describe('signed-out page visits', () => {
  it('redirect to the login page, then back to where they were going', async () => {
    const visit = browser(makeHttp('/login'))
    const res = await visit('/dashboard?tab=billing')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    const signedIn = await visit('/login', { method: 'POST' })
    expect(signedIn.status).toBe(303)
    expect(signedIn.headers.get('location')).toBe('/dashboard?tab=billing')
    // Used once.
    expect((await visit('/login', { method: 'POST' })).headers.get('location')).toBe('/home')
  })

  it('redirects Inertia visits too, with 303 after a form post and nothing remembered', async () => {
    const visit = browser(makeHttp('/login'))
    const res = await visit('/posts', { method: 'POST', headers: { 'x-inertia': 'true', accept: 'text/html, application/xhtml+xml' } })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
    expect((await visit('/login', { method: 'POST' })).headers.get('location')).toBe('/home')
  })

  it('keeps the 401 envelope for API clients', async () => {
    const res = await makeHttp('/login').request('/dashboard', { headers: { accept: 'application/json' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  it('keeps the 401 when no login page is configured, or for the login page itself', async () => {
    expect((await makeHttp().request('/dashboard', { headers: page })).status).toBe(401)
    expect((await makeHttp('/login').request('/login', { headers: page })).status).toBe(401)
  })
})

it('intended() only follows paths on this site', async () => {
  for (const to of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
    const visit = browser(makeHttp('/login'))
    await visit(`/plant?to=${encodeURIComponent(to)}`, { method: 'POST' })
    expect((await visit('/login', { method: 'POST' })).headers.get('location')).toBe('/home')
  }
})

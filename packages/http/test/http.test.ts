import { CalderaError } from '@caldera-js/core'
import { Hono, type MiddlewareHandler } from 'hono'
import { hc } from 'hono/client'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  createRouter,
  defineMiddleware,
  defineRequest,
  defineRoutes,
  errorHandler,
  NotFoundError,
  notFoundHandler,
  originCheck,
  securityHeaders,
  sortByPriority,
  type ErrorBody,
  ValidationError,
} from '../src/index.js'

const trace: string[] = []
const tracer =
  (label: string): MiddlewareHandler =>
  async (_c, next) => {
    trace.push(label)
    await next()
  }

const mw = defineMiddleware({
  auth: (options: { guard: 'session' | 'token' }) => tracer(`auth:${options.guard}`),
  throttle: (options: { perMinute: number }) => tracer(`throttle:${options.perMinute}`),
  audit: () => tracer('audit'),
})

const StorePost = defineRequest({
  body: z.object({ title: z.string().min(3), tags: z.array(z.string()).default([]) }),
  prepare: (raw) => (raw && typeof raw === 'object' ? { ...raw, title: String((raw as { title?: unknown }).title ?? '').trim() } : raw),
  authorize: (c) => c.req.header('x-role') !== 'guest',
})

const ShowPost = defineRequest({ params: z.object({ post: z.coerce.number().int().positive() }) })
const ListPosts = defineRequest({ query: z.object({ page: z.coerce.number().default(1), q: z.string().optional() }) })

const posts = defineRoutes('posts', { prefix: '/posts', middleware: [mw.audit()] })
  .get('index', '/', { request: ListPosts }, (c) => c.json({ page: c.req.valid('query').page, q: c.req.valid('query').q ?? null }))
  .get('show', '/:post', { request: ShowPost }, (c) => {
    const { post } = c.req.valid('param')
    if (post === 404) throw new NotFoundError('post')
    return c.json({ id: post })
  })
  .post('store', '/', { request: StorePost, middleware: [mw.throttle({ perMinute: 10 }), mw.auth({ guard: 'session' })] }, (c) =>
    c.json({ created: c.req.valid('json') }, 201),
  )

const health = defineRoutes('health').get('check', '/health', (c) => c.text('ok'))

const router = createRouter(posts, health)

function server() {
  return new Hono()
    .use(securityHeaders())
    .use(originCheck({ trustedOrigins: ['https://app.example.test'] }))
    .route('/', router.app)
    .onError(errorHandler())
    .notFound(notFoundHandler())
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  body: JSON.stringify(body),
})

describe('routes and requests', () => {
  it('validates, prepares and types input', async () => {
    const res = await server().request('/posts', json({ title: '  Hello  ' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ created: { title: 'Hello', tags: [] } })
  })

  it('coerces params and query', async () => {
    expect(await (await server().request('/posts/42')).json()).toEqual({ id: 42 })
    expect(await (await server().request('/posts?page=3')).json()).toEqual({ page: 3, q: null })
  })

  it('returns the standard 422 envelope with per-field messages', async () => {
    const res = await server().request('/posts', json({ title: 'x', tags: 'nope' }, { 'x-request-id': 'req-1' }))
    expect(res.status).toBe(422)
    const body = (await res.json()) as ErrorBody
    expect(body.error).toMatchObject({ code: 'validation_failed', status: 422, requestId: 'req-1' })
    expect(Object.keys(body.error.fields!).sort()).toEqual(['tags', 'title'])
  })

  it('runs authorize before parsing input', async () => {
    const res = await server().request('/posts', json({ title: 'x' }, { 'x-role': 'guest' }))
    expect(res.status).toBe(403)
    expect(((await res.json()) as ErrorBody).error.code).toBe('forbidden')
  })

  it('uses the same envelope for not-found, bad JSON and unexpected errors', async () => {
    const missing = await server().request('/posts/404')
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found', status: 404, message: 'Not found.' } })
    expect((await server().request('/nope')).status).toBe(404)

    const modelMissing = new Hono()
      .get('/', () => {
        throw new CalderaError('not_found', 'No post found for "abc".')
      })
      .onError(errorHandler())
    expect(await (await modelMissing.request('/')).json()).toMatchObject({ error: { code: 'not_found', status: 404, message: 'Not found.' } })
    // Other packages refuse input the same way (e.g. claimUpload on a used upload).
    const refused = new Hono()
      .get('/', () => {
        throw new CalderaError('validation_failed', 'Already used.', { fields: { avatar: ['Already used.'] } })
      })
      .onError(errorHandler())
    expect(await (await refused.request('/')).json()).toMatchObject({ error: { code: 'validation_failed', status: 422, fields: { avatar: ['Already used.'] } } })

    const badJson = await server().request('/posts', { ...json({}), body: '{oops' })
    expect(await badJson.json()).toMatchObject({ error: { code: 'bad_request', status: 400 } })

    const reported: unknown[] = []
    const boom = new Hono()
      .get('/', () => {
        throw new Error('database password is hunter2')
      })
      .onError(errorHandler({ report: (e) => reported.push(e) }))
    const res = await boom.request('/')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('hunter2')
    expect(reported).toHaveLength(1)
  })

  it('orders middleware by priority, keeping unlisted ones in place', async () => {
    trace.length = 0
    await server().request('/posts', json({ title: 'Ordered' }))
    // Declared as audit, throttle, auth: priority puts auth before throttle; audit is unlisted.
    expect(trace).toEqual(['audit', 'auth:session', 'throttle:10'])
    expect(sortByPriority([{ name: 'x' }, { name: 'validate' }, { name: 'y' }, { name: 'auth' }], ['auth', 'validate']).map((m) => m.name)).toEqual([
      'x',
      'auth',
      'y',
      'validate',
    ])
  })

  it('rejects duplicate route names', () => {
    const group = defineRoutes('dupe').get('a', '/a', (c) => c.text('a'))
    expect(() => group.get('a', '/b', (c) => c.text('b'))).toThrow(/defined twice/)
    expect(() => createRouter(defineRoutes('g').get('x', '/1', (c) => c.text('')), defineRoutes('g').get('x', '/2', (c) => c.text('')))).toThrow(/more than one group/)
  })
})

describe('typed URLs and clients', () => {
  it('builds URLs from route names with typed params', () => {
    expect(router.url('posts.show', { post: 7 })).toBe('/posts/7')
    expect(router.url('posts.index', {}, { page: 2, tags: ['a', 'b'] })).toBe('/posts?page=2&tags=a&tags=b')
    expect(router.url('health.check')).toBe('/health')
    // @ts-expect-error unknown route name
    expect(() => router.url('posts.shw', {})).toThrow(/Unknown route/)
    // @ts-expect-error missing required param
    expect(() => router.url('posts.show', {})).toThrow(/Missing route parameter "post"/)
  })

  it('keeps Hono client inference end to end', async () => {
    const app = server()
    const client = hc<typeof router.app>('http://localhost', { fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init) })
    const res = await client.posts.$post({ json: { title: 'From client' } }, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(res.status).toBe(201)
    if (res.status === 201) {
      const data = await res.json()
      expectTypeOf(data.created.title).toEqualTypeOf<string>()
      expect(data.created.tags).toEqual([])
    }
    // @ts-expect-error title is required
    void (() => client.posts.$post({ json: {} }))
  })
})

describe('route manifest', () => {
  it('describes every route with input schemas, middleware and source location', () => {
    const { routes } = JSON.parse(JSON.stringify(router.manifest())) as ReturnType<typeof router.manifest>
    const store = routes.find((r) => r.name === 'posts.store')!
    expect(store).toMatchObject({
      method: 'POST',
      path: '/posts',
      params: [],
      middleware: [
        { name: 'audit', options: null },
        { name: 'auth', options: { guard: 'session' } },
        { name: 'throttle', options: { perMinute: 10 } },
        { name: 'authorize', options: null },
      ],
    })
    expect((store.input.body as { required: string[] }).required).toEqual(['title'])
    expect(store.source?.file).toMatch(/http\.test\.ts$/)
    expect(routes.find((r) => r.name === 'posts.show')?.params).toEqual(['post'])
  })
})

describe('security', () => {
  const post = (headers: Record<string, string>) => server().request('https://app.example.test/posts', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"title":"Safe"}' })

  it('allows same-origin and trusted origins', async () => {
    expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(201)
    expect((await post({ origin: 'https://app.example.test' })).status).toBe(201)
    expect((await post({})).status).toBe(201) // no browser headers and no cookies: an API client
  })

  it('blocks cross-site browser requests', async () => {
    const attempts: Record<string, string>[] = [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.test' }, { cookie: 'session=abc' }, { referer: 'https://evil.test/page' }]
    for (const headers of attempts) {
      const res = await post(headers)
      expect(res.status).toBe(403)
      expect(((await res.json()) as ErrorBody).error.code).toBe('csrf_failed')
    }
  })

  it('never blocks safe methods and sends secure headers', async () => {
    const res = await server().request('/health', { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('strict-transport-security')).toBeNull()
    expect(res.headers.get('content-security-policy')).toMatch(
      /^script-src 'nonce-[\w+/=]+' 'strict-dynamic' https: 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'$/,
    )
  })

  it('sends HSTS on HTTPS requests by default, not over plain HTTP; or as told', async () => {
    const app = (hsts?: boolean) => new Hono().use(securityHeaders(hsts === undefined ? {} : { hsts })).get('/', (c) => c.text('ok'))
    const hstsOf = async (server: Hono, url: string) => (await server.request(url)).headers.get('strict-transport-security')
    expect(await hstsOf(app(), 'https://app.example/')).toBe('max-age=31536000; includeSubDomains')
    expect(await hstsOf(app(), 'http://localhost/')).toBeNull()
    expect(await hstsOf(app(true), 'http://localhost/')).toBe('max-age=31536000; includeSubDomains')
    expect(await hstsOf(app(false), 'https://app.example/')).toBeNull()
  })

  it('merges app CSP directives over the strict default, or turns it off', async () => {
    const custom = new Hono().use(securityHeaders({ csp: { imgSrc: ["'self'"], frameAncestors: ["'self'"] } })).get('/', (c) => c.text('ok'))
    const policy = (await custom.request('/')).headers.get('content-security-policy')!
    expect(policy).toContain("img-src 'self'")
    expect(policy).toContain("frame-ancestors 'self'")
    expect(policy).toContain("'strict-dynamic'")
    const off = new Hono().use(securityHeaders({ csp: false })).get('/', (c) => c.text('ok'))
    expect((await off.request('/')).headers.get('content-security-policy')).toBeNull()
  })
})

describe('translated validation messages', () => {
  const French = defineRequest({
    body: z.object({
      // A message key: translated. A sentence: kept as written.
      name: z.string().min(2, 'projects.name_short'),
      key: z.string().min(1, 'Use a key.'),
    }),
  })
  const app = new Hono()
    .use(async (c, next) => {
      const messages: Record<string, string> = { 'projects.name_short': 'Au moins {minimum} caractères.', 'projects.key_taken': 'Clé déjà prise.' }
      c.set('i18n' as never, {
        zodError: () => undefined,
        has: (key: string) => key in messages,
        t: (key: string, params?: { minimum?: number }) => messages[key]!.replace('{minimum}', String(params?.minimum)),
      } as never)
      await next()
    })
    .route(
      '/',
      createRouter(
        defineRoutes('projects')
          .post('store', '/projects', { request: French }, (c) => c.json(c.req.valid('json')))
          .post('taken', '/taken', () => {
            throw new ValidationError({ key: ['projects.key_taken', 'Already used.'] })
          }),
      ).app,
    )
    .onError(errorHandler())

  it('translates a schema message that is a message key, with the rule’s bounds', async () => {
    const res = await app.request('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a', key: '' }) })
    expect(res.status).toBe(422)
    expect(((await res.json()) as ErrorBody).error.fields).toEqual({ name: ['Au moins 2 caractères.'], key: ['Use a key.'] })
  })

  it('translates message keys in a ValidationError thrown by a handler', async () => {
    const res = await app.request('/taken', { method: 'POST' })
    expect(((await res.json()) as ErrorBody).error.fields).toEqual({ key: ['Clé déjà prise.', 'Already used.'] })
  })
})

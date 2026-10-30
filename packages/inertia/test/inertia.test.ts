import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, defineEnv } from '@caldera/core'
import { back, errorHandler, redirect, sessionOf, sessionProvider, startSession, ValidationError } from '@caldera/http'
import { Hono } from 'hono'
import { secureHeaders, NONCE } from 'hono/secure-headers'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { always, appearance, appearanceOf, defer, defineInertia, location, optional, viteAssets, type PageObject, type RenderProps, type SsrRenderer } from '../src/index.js'

// What `caldera generate` writes from resources/pages and src/inertia.ts.
declare module '../src/inertia.js' {
  interface PageRegistry {
    'Posts/Index': { posts: { id: number; title: string }[]; stats?: { total: number }; filters?: string[]; auth: { user: string | null }; errors: Record<string, string> }
    Home: { greeting: string }
  }
  interface InertiaRegister {
    shared: { auth: { user: string | null } }
  }
}

const KEY = 'test-key-0123456789-0123456789-0123'
const calls: string[] = []

function makeHttp(options: Parameters<typeof defineInertia>[0] = {}) {
  const app = createApp({ env: defineEnv({}), providers: [sessionProvider(() => ({ keys: [KEY] }))] })
  const inertia = defineInertia({ version: 'v1', share: () => ({ auth: { user: 'ann' } }), ...options })
  return new Hono()
    .use(app.middleware())
    .use(startSession())
    .use(inertia.middleware())
    .get('/posts', (c) =>
      c.render('Posts/Index', {
        posts: () => (calls.push('posts'), [{ id: 1, title: '</script><script>alert(1)</script>' }]),
        stats: defer(() => (calls.push('stats'), { total: 1 })),
        filters: optional(() => (calls.push('filters'), ['draft'])),
      }),
    )
    .get('/home', (c) => c.render('Home', { greeting: 'hi' }))
    .post('/posts', () => {
      throw new ValidationError({ title: ['Too short'] })
    })
    .post('/saved', (c) => back(c).with('success', 'Saved'))
    .get('/hop', (c) => redirect(c, '/home'))
    .put('/legacy', (c) => c.redirect('/home'))
    .post('/anchor', (c) => c.redirect('/home#comments'))
    .post('/empty', (c) => c.body(null))
    .get('/away', (c) => location(c, 'https://billing.example/'))
    .onError(errorHandler())
}

const inertiaHeaders = { 'x-inertia': 'true', 'x-inertia-version': 'v1' }

type Http = { request: Hono["request"] }

async function visit(http: Http, path: string, headers: Record<string, string> = {}, init: RequestInit = {}) {
  return http.request(`http://localhost${path}`, { ...init, headers: { ...inertiaHeaders, ...headers } })
}

describe('rendering', () => {
  it('serves the first visit as HTML with the page embedded safely', async () => {
    const res = await makeHttp({ title: 'Blog' }).request('/posts')
    const html = await res.text()
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('vary')).toContain('X-Inertia')
    expect(html).toContain('<title>Blog</title>')
    expect(html).toContain('<div id="app"></div>')
    expect(html).not.toContain('</script><script>alert(1)')
    const json = html.match(/<script data-page="app" type="application\/json">(.*?)<\/script>/s)![1]!
    const page = JSON.parse(json) as PageObject
    expect(page).toMatchObject({ component: 'Posts/Index', url: '/posts', version: 'v1', sharedProps: ['auth'] })
    expect(page.props.posts).toEqual([{ id: 1, title: '</script><script>alert(1)</script>' }])
  })

  it('answers Inertia visits with the page object as JSON', async () => {
    const res = await visit(makeHttp(), '/posts?page=2')
    expect(res.headers.get('x-inertia')).toBe('true')
    const page = (await res.json()) as PageObject
    expect(page.url).toBe('/posts?page=2')
    expect(page.props.auth).toEqual({ user: 'ann' })
    expect(page.props.errors).toEqual({})
  })

  it('leaves optional and deferred props out of the first load, listing deferred ones by group', async () => {
    calls.length = 0
    const page = (await (await visit(makeHttp(), '/posts')).json()) as PageObject
    expect(Object.keys(page.props).sort()).toEqual(['auth', 'errors', 'posts'])
    expect(page.deferredProps).toEqual({ default: ['stats'] })
    expect(calls).toEqual(['posts'])
  })

  it('computes only the requested props on a partial reload, plus always props', async () => {
    calls.length = 0
    const headers = { 'x-inertia-partial-component': 'Posts/Index', 'x-inertia-partial-data': 'stats,filters' }
    const page = (await (await visit(makeHttp(), '/posts', headers)).json()) as PageObject
    expect(page.props).toEqual({ stats: { total: 1 }, filters: ['draft'], errors: {} })
    expect(calls.sort()).toEqual(['filters', 'stats'])
  })

  it('ignores partial headers meant for another component', async () => {
    const headers = { 'x-inertia-partial-component': 'Other', 'x-inertia-partial-data': 'stats' }
    const page = (await (await visit(makeHttp(), '/posts', headers)).json()) as PageObject
    expect(page.props.posts).toBeDefined()
    expect(page.props.stats).toBeUndefined()
  })

  it('supports except and dot paths into literal objects', async () => {
    const http = new Hono().use(defineInertia().middleware()).get('/', (c) =>
      c.render('Home', { greeting: 'hi', nav: { main: () => ['a'], footer: () => ['b'] }, pinned: always('yes') } as never),
    )
    const only = { 'x-inertia': 'true', 'x-inertia-partial-component': 'Home', 'x-inertia-partial-data': 'nav.footer' }
    expect((await (await http.request('/', { headers: only })).json()).props).toEqual({ nav: { footer: ['b'] }, pinned: 'yes', errors: {} })
    const except = { 'x-inertia': 'true', 'x-inertia-partial-component': 'Home', 'x-inertia-partial-except': 'nav' }
    expect((await (await http.request('/', { headers: except })).json()).props).toEqual({ greeting: 'hi', pinned: 'yes', errors: {} })
  })

  it('forces a full reload when the asset version changed', async () => {
    const res = await visit(makeHttp(), '/posts', { 'x-inertia-version': 'old' })
    expect(res.status).toBe(409)
    expect(res.headers.get('x-inertia-location')).toBe('http://localhost/posts')
  })

  it('adds the CSP nonce to asset tags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caldera-vite-'))
    const assets = viteAssets({ entry: 'resources/app.tsx', hotFile: join(dir, 'none'), manifest: { 'resources/app.tsx': { file: 'assets/app-1.js', isEntry: true } } })
    const http = new Hono()
      .use(secureHeaders({ contentSecurityPolicy: { scriptSrc: [NONCE] } }))
      .use(defineInertia({ assets }).middleware())
      .get('/', (c) => c.render('Home', { greeting: 'hi' }))
    const res = await http.request('/')
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy')!)![1]
    expect(await res.text()).toContain(`<script type="module" src="/build/assets/app-1.js" nonce="${nonce}"></script>`)
    rmSync(dir, { recursive: true })
  })
})

describe('appearance', () => {
  const http = () => {
    const page = new Hono()
      .use(secureHeaders({ contentSecurityPolicy: { scriptSrc: [NONCE] } }))
      .use(defineInertia({ document: [appearance(), { attributes: () => ({ class: 'antialiased', 'data-x': 'y' }) }] }).middleware())
      .get('/', (c) => c.render('Home', { greeting: 'hi' }))
      .get('/which', (c) => c.text(appearanceOf(c)))
    return page
  }
  const first = async (cookie?: string) => {
    const res = await http().request('/', cookie ? { headers: { cookie } } : {})
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy')!)![1]!
    return { html: await res.text(), nonce }
  }

  it('renders an explicit choice into <html>, so dark pages never flash light', async () => {
    const { html } = await first('appearance=dark')
    expect(html).toContain('<html lang="en" class="dark antialiased" style="color-scheme: dark" data-x="y">')
    // No script needed; the background is painted before the stylesheet loads.
    expect(html).not.toContain('matchMedia')
    expect(html).toMatch(/<style nonce="[^"]+">html\{background-color:#ffffff\}html\.dark\{background-color:#161616\}<\/style>/)
    expect((await first('appearance=light')).html).toContain('<html lang="en" style="color-scheme: light" class="antialiased" data-x="y">')
  })

  it('resolves `system` in the browser before the first paint, with the CSP nonce', async () => {
    const { html, nonce } = await first()
    expect(html).toContain('<html lang="en" class="antialiased" data-x="y">')
    const head = html.slice(html.indexOf('<head>'), html.indexOf('<title>'))
    expect(head).toContain(`<script nonce="${nonce}">(function(){var d=window.matchMedia('(prefers-color-scheme: dark)')`)
  })

  it('treats unknown cookie values as system', async () => {
    expect(await (await http().request('/which', { headers: { cookie: 'appearance=%22%3E%3Cscript%3E' } })).text()).toBe('system')
    expect(await (await http().request('/which', { headers: { cookie: 'appearance=dark' } })).text()).toBe('dark')
    expect((await first('appearance=purple')).html).toContain('matchMedia')
  })
})

/** Follows redirects like the Inertia client: same headers, cookie jar kept. */
function client(http: Http) {
  let cookie = ''
  return async (path: string, init: RequestInit = {}) => {
    const headers = { ...inertiaHeaders, referer: 'http://localhost/posts', ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) }
    const res = await http.request(`http://localhost${path}`, { ...init, headers })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return res
  }
}

describe('errors and flash', () => {
  it('shows validation errors on the page the form came from, first message per field', async () => {
    const send = client(makeHttp())
    const failed = await send('/posts', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(failed.status).toBe(303)
    expect(failed.headers.get('location')).toBe('/posts')
    const page = (await (await send('/posts')).json()) as PageObject
    expect(page.props.errors).toEqual({ title: 'Too short' })
    expect(((await (await send('/posts')).json()) as PageObject).props.errors).toEqual({})
  })

  it('nests errors under the error bag the form asked for', async () => {
    const send = client(makeHttp())
    await send('/posts', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-inertia-error-bag': 'createPost' } })
    expect(((await (await send('/posts')).json()) as PageObject).props.errors).toEqual({ createPost: { title: 'Too short' } })
  })

  it('puts flash data on the page object, and keeps it through extra redirects', async () => {
    const send = client(makeHttp())
    await send('/saved', { method: 'POST' })
    expect((await send('/hop')).status).toBe(302)
    const page = (await (await send('/home')).json()) as PageObject
    expect(page.flash).toEqual({ success: 'Saved' })
    expect(((await (await send('/home')).json()) as PageObject).flash).toBeUndefined()
  })
})

describe('redirects', () => {
  it('turns 302 into 303 after PUT, PATCH and DELETE', async () => {
    const res = await visit(makeHttp(), '/legacy', {}, { method: 'PUT' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/home')
  })

  it('hands redirects with a fragment to the client', async () => {
    const res = await visit(makeHttp(), '/anchor', {}, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(res.headers.get('x-inertia-redirect')).toBe('/home#comments')
  })

  it('treats an empty response as "go back"', async () => {
    const res = await visit(makeHttp(), '/empty', { referer: 'http://localhost/posts' }, { method: 'POST' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/posts')
  })

  it('location() makes Inertia do a full visit, and plain requests a redirect', async () => {
    const res = await visit(makeHttp(), '/away')
    expect(res.status).toBe(409)
    expect(res.headers.get('x-inertia-location')).toBe('https://billing.example/')
    expect((await makeHttp().request('/away')).status).toBe(302)
  })
})

it('never reads the asset manifest for routes that don’t render a page', async () => {
  const assets = viteAssets({ entry: 'resources/app.tsx', manifest: () => Promise.reject(new Error('no build')) })
  const http = new Hono()
    .use(defineInertia({ assets }).middleware())
    .get('/api', (c) => c.json({ ok: true }))
    .get('/page', (c) => c.render('Home', { greeting: 'hi' }))
    .onError((error, c) => c.text(error.message, 500))
  expect((await http.request('/api')).status).toBe(200)
  expect((await http.request('/api', { method: 'POST' })).status).toBe(404)
  // Pages still need the build, and say so.
  expect(await (await http.request('/page')).text()).toBe('no build')
})

describe('viteAssets', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const manifest = {
    'resources/app.tsx': { file: 'assets/app-abc.js', isEntry: true, imports: ['_vendor.js'], css: ['assets/app-def.css'] },
    '_vendor.js': { file: 'assets/vendor-123.js', css: ['assets/vendor-456.css'] },
  }

  it('builds tags from the manifest: styles, preloads, then the entry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'caldera-vite-'))
    const assets = viteAssets({ entry: 'resources/app.tsx', manifest, hotFile: join(dir, 'vite.hot') })
    expect((await assets.tags()).split('\n')).toEqual([
      '<link rel="stylesheet" href="/build/assets/app-def.css">',
      '<link rel="stylesheet" href="/build/assets/vendor-456.css">',
      '<link rel="modulepreload" href="/build/assets/vendor-123.js">',
      '<script type="module" src="/build/assets/app-abc.js"></script>',
    ])
    expect(await assets.version()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('points at the dev server while it runs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'caldera-vite-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'vite.hot'), 'http://localhost:5173\n')
    const assets = viteAssets({ entry: 'resources/app.tsx', manifest, hotFile: join(dir, 'vite.hot') })
    expect(await assets.tags()).toBe(
      '<script type="module" src="http://localhost:5173/@vite/client"></script>\n<script type="module" src="http://localhost:5173/resources/app.tsx"></script>',
    )
    expect(await assets.version()).toBe('dev')
  })

  it('renders without tags in tests when nothing is built', async () => {
    dir = mkdtempSync(join(tmpdir(), 'caldera-vite-'))
    const assets = viteAssets({ entry: 'resources/app.tsx', hotFile: join(dir, 'vite.hot') })
    expect(await assets.tags()).toBe('')
    expect(await assets.version()).toBeNull()
  })

  it('explains a missing entry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'caldera-vite-'))
    const assets = viteAssets({ entry: 'resources/other.tsx', manifest, hotFile: join(dir, 'vite.hot') })
    await expect(assets.tags()).rejects.toThrow(/isn't in the Vite manifest/)
  })
})

it('types c.render from the page registry, minus shared props and errors', () => {
  expectTypeOf<RenderProps<'Home'>>().toEqualTypeOf<{ greeting: string | (() => string | Promise<string>) | import('../src/props.js').Prop<string> }>()
  new Hono().get('/', (c) => {
    // @ts-expect-error unknown page
    void c.render('Nope', {})
    // @ts-expect-error missing required prop
    void c.render('Home', {})
    return c.render('Posts/Index', { posts: [], stats: defer(async () => ({ total: 0 })) })
  })
  void sessionOf
})

describe('server-side rendering', () => {
  const ssrBody = (page: { component: string }) => `<script data-page="app" type="application/json">{}</script><div data-server-rendered="true" id="app"><h1>${page.component} on the server</h1></div>`

  it('renders first loads on the server: head tags, then the body in place of the empty app div', async () => {
    const seen: string[] = []
    const http = makeHttp({
      ssr: { render: async (page) => (seen.push(page.component), { head: ['<title inertia>Home · App</title>', '<script>window.x = 1</script>'], body: ssrBody(page) }) },
    })
    const html = await (await http.request('/home')).text()
    expect(html).toContain('<div data-server-rendered="true" id="app"><h1>Home on the server</h1></div>')
    expect(html).not.toContain('<div id="app"></div>')
    // The page's own <title> replaces the default one.
    expect(html.match(/<title/g)).toHaveLength(1)
    expect(html).toContain('<title inertia>Home · App</title>')
    expect(seen).toEqual(['Home'])
    // Inertia visits are JSON: never rendered on the server.
    await http.request('/home', { headers: { 'x-inertia': 'true', 'x-inertia-version': 'v1' } })
    expect(seen).toEqual(['Home'])
  })

  it('gives scripts in the head the request’s CSP nonce', async () => {
    const http = new Hono()
      .use(secureHeaders({ contentSecurityPolicy: { scriptSrc: [NONCE] } }))
      .route('/', makeHttp({ ssr: { render: async (page) => ({ head: ['<script>window.x = 1</script>'], body: ssrBody(page) }) } }))
    const res = await http.request('/home')
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1]
    expect(await res.text()).toContain(`<script nonce="${nonce}">window.x = 1</script>`)
  })

  it('falls back to client rendering when SSR fails or is too slow', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = makeHttp({ ssr: { render: async () => Promise.reject(new Error('window is not defined')) } })
    const html = await (await failing.request('/home')).text()
    expect(html).toContain('<div id="app"></div>')
    expect(html).toContain('<script data-page="app" type="application/json">')
    const slow = makeHttp({ ssr: { timeout: 50, render: () => new Promise((resolve) => setTimeout(() => resolve({ head: [], body: 'late' }), 500)) } })
    expect(await (await slow.request('/home')).text()).toContain('<div id="app"></div>')
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
      '[caldera] SSR failed for Home (/home), rendering on the client: window is not defined',
      '[caldera] SSR failed for Home (/home), rendering on the client: took longer than 50ms',
    ])
    error.mockRestore()
  })
})

describe('server-side rendering, cold start', () => {
  it('loads the renderer outside the timeout, so a slow first load still renders on the server', async () => {
    let ready = false
    const http = makeHttp({
      ssr: {
        timeout: 50,
        prepare: () => new Promise((resolve) => setTimeout(() => ((ready = true), resolve(undefined)), 200)),
        render: async (page) => ({ head: [], body: `<div data-server-rendered="true" id="app">${ready ? page.component : 'cold'}</div>` }),
      },
    })
    expect(await (await http.request('/home')).text()).toContain('<div data-server-rendered="true" id="app">Home</div>')
  })
})

describe('server-side rendering, opting pages out', () => {
  it('skips the server for c.render(…, { ssr: false }) and for viteSsr({ except }) patterns, quietly', async () => {
    const { viteSsr } = await import('../src/index.js')
    const seen: string[] = []
    const renderer = { render: async (page: { component: string }) => (seen.push(page.component), { head: [], body: `<div data-server-rendered="true" id="app">${page.component}</div>` }) }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp({ env: defineEnv({}), providers: [sessionProvider(() => ({ keys: [KEY] }))] })
    const http = (ssr: SsrRenderer) =>
      new Hono()
        .use(app.middleware())
        .use(startSession())
        .use(defineInertia({ version: 'v1', ssr }).middleware())
        .get('/home', (c) => c.render('Home', { greeting: 'hi' }))
        .get('/map', (c) => c.render('Places/Map' as never, {} as never, { ssr: false }))
        .get('/admin', (c) => c.render('Admin/Users' as never, {} as never))
    const withRenderer = http(renderer)
    expect(await (await withRenderer.request('/home')).text()).toContain('data-server-rendered')
    expect(await (await withRenderer.request('/map')).text()).toContain('<div id="app"></div>')
    expect(seen).toEqual(['Home'])
    // Patterns, on viteSsr (here with a render function supplied, as bundled deployments do).
    const patterned = viteSsr({ except: ['Admin/*', '*/Map'] })
    expect([patterned.skips!('Admin/Users'), patterned.skips!('Places/Map'), patterned.skips!('Home'), patterned.skips!('Administration')]).toEqual([true, true, false, false])
    expect(await (await http(patterned).request('/admin')).text()).toContain('<div id="app"></div>')
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

import { TestResponse } from './response.js'

/** Anything with Hono's `request()`: the app's `http` from src/http.ts. */
export interface Requestable {
  request(input: string, init?: RequestInit, env?: unknown): Response | Promise<Response>
}

export interface RequestOptions {
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | readonly (string | number)[]>
  /** A JSON body. */
  json?: unknown
  /** A form body: urlencoded, or multipart when a value is a Blob or File. */
  form?: Record<string, string | number | boolean | Blob | readonly (string | Blob)[]>
}

export interface TestClientOptions {
  /** The origin requests come from (and that the origin check sees). Default http://localhost. */
  baseUrl?: string
  /** Passed to the app as Hono's `env` (Workers-style bindings). */
  env?: unknown
  headers?: Record<string, string>
  /** Send every request as an Inertia visit. */
  inertia?: boolean
  /** The app's services, for `actingAs` (its Better Auth instance). `t.client()` passes them. */
  services?: object
}

interface Shared {
  cookies: Map<string, string>
  inertiaVersion: string | undefined
  /** The last page loaded, sent as Referer like a browser (what `back()` returns to). */
  referer: string | undefined
}

/**
 * Requests to the app in-process, like a browser: cookies are kept (the session, flash data,
 * the locale), the last page loaded is the Referer (so `back()` works), unsafe methods carry the
 * app's own Origin so `originCheck()` lets them through,
 * and redirects aren't followed unless you ask (`followRedirect()`), so you can assert on them.
 */
export class TestClient {
  readonly #app: Requestable
  readonly #options: Required<Pick<TestClientOptions, 'baseUrl'>> & TestClientOptions
  readonly #shared: Shared

  constructor(app: Requestable, options: TestClientOptions = {}, shared?: Shared) {
    this.#app = app
    this.#options = { baseUrl: 'http://localhost', ...options }
    this.#shared = shared ?? { cookies: new Map(), inertiaVersion: undefined, referer: undefined }
  }

  /** A client sharing these cookies, with extra headers on every request. */
  withHeaders(headers: Record<string, string>): TestClient {
    return new TestClient(this.#app, { ...this.#options, headers: { ...this.#options.headers, ...headers } }, this.#shared)
  }

  /** A client sharing these cookies whose requests are Inertia visits (pages answer with JSON). */
  inertia(): TestClient {
    return new TestClient(this.#app, { ...this.#options, inertia: true }, this.#shared)
  }

  /** An Inertia visit: `(await client.visit('/posts')).assertInertia('Posts/Index')`. */
  visit(path: string, options: Omit<RequestOptions, 'json' | 'form'> = {}): Promise<TestResponse> {
    return this.inertia().get(path, options)
  }

  /** Sets a cookie, e.g. `client.withCookie('caldera_locale', 'fr')`. */
  withCookie(name: string, value: string): this {
    this.#shared.cookies.set(name, value)
    return this
  }

  /**
   * Signs in as `user` (a row with an `id`) with a real Better Auth session, as if they'd signed in:
   * `await client.actingAs(user)`. Needs betterAuthProvider() in the app and @caldera/auth.
   */
  async actingAs(user: { id: string | number }): Promise<this> {
    const auth = (this.#options.services as { auth?: { $context: Promise<unknown> } } | undefined)?.auth
    if (!auth) throw new Error('actingAs() needs the app’s Better Auth instance: use t.client(http) from setupApp, with betterAuthProvider() in the app.')
    const { sessionCookieFor } = await import('@caldera/auth/testing')
    const cookie = await sessionCookieFor(auth, user)
    return this.withCookie(cookie.name, cookie.value)
  }

  cookie(name: string): string | undefined {
    return this.#shared.cookies.get(name)
  }

  get(path: string, options?: RequestOptions) {
    return this.request('GET', path, options)
  }
  post(path: string, options?: RequestOptions) {
    return this.request('POST', path, options)
  }
  put(path: string, options?: RequestOptions) {
    return this.request('PUT', path, options)
  }
  patch(path: string, options?: RequestOptions) {
    return this.request('PATCH', path, options)
  }
  delete(path: string, options?: RequestOptions) {
    return this.request('DELETE', path, options)
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const url = new URL(path, this.#options.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
    }
    const headers = new Headers({ ...this.#options.headers, ...options.headers })
    if (this.#shared.referer && !headers.has('referer')) headers.set('referer', this.#shared.referer)
    if (this.#shared.cookies.size && !headers.has('cookie')) headers.set('cookie', [...this.#shared.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (!headers.has('origin')) headers.set('origin', url.origin)
      if (!headers.has('sec-fetch-site')) headers.set('sec-fetch-site', 'same-origin')
    }
    if (this.#options.inertia) {
      headers.set('x-inertia', 'true')
      if (this.#shared.inertiaVersion !== undefined && !headers.has('x-inertia-version')) headers.set('x-inertia-version', this.#shared.inertiaVersion)
    }
    let body: BodyInit | undefined
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.json)
    } else if (options.form) {
      const entries = Object.entries(options.form).flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => [key, v] as const) : [[key, value] as const]))
      if (entries.some(([, value]) => value instanceof Blob)) {
        const form = new FormData()
        for (const [key, value] of entries) form.append(key, value instanceof Blob ? value : String(value))
        body = form
      } else {
        body = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]))
      }
    }
    const send = () => Promise.resolve(this.#app.request(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}) }, this.#options.env))
    let response = await send()
    // An Inertia visit with an old (or no) asset version is told to reload: take the version and retry once.
    if (response.status === 409 && this.#options.inertia && response.headers.get('x-inertia-version') !== null && !options.headers?.['x-inertia-version']) {
      this.#shared.inertiaVersion = response.headers.get('x-inertia-version') ?? undefined
      headers.set('x-inertia-version', this.#shared.inertiaVersion ?? '')
      response = await send()
    }
    this.#store(response.headers)
    if (method === 'GET' && response.status >= 200 && response.status < 300) this.#shared.referer = url.toString()
    const result = { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) }
    // Following a redirect is a GET, as browsers do after a form post (303).
    return new TestResponse(result, { method, path: url.pathname + url.search }, (location) => this.get(new URL(location, url).pathname + new URL(location, url).search))
  }

  #store(headers: Headers) {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const index = pair!.indexOf('=')
      const name = pair!.slice(0, index).trim()
      const value = pair!.slice(index + 1).trim()
      const expired = attributes.some((a) => {
        const [key, val] = a.trim().split('=')
        if (key?.toLowerCase() === 'max-age') return Number(val) <= 0
        if (key?.toLowerCase() === 'expires') return new Date(val ?? '').getTime() <= Date.now()
        return false
      })
      if (expired || value === '') this.#shared.cookies.delete(name)
      else this.#shared.cookies.set(name, value)
    }
  }
}

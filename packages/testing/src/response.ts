import { expect } from 'vitest'

/** The Inertia page a response carries: the JSON of a visit, or the `data-page` script of a first load. */
export interface InertiaPage {
  component: string
  props: Record<string, unknown> & { errors?: Record<string, unknown> }
  url: string
  version: string | null
  flash?: Record<string, unknown>
}

type FollowRedirect = (location: string) => Promise<TestResponse>

/**
 * A response with Laravel-style assertions. Each returns the response, so they chain:
 * `(await client.post('/posts', { json })).assertCreated().assertJson({ post: { title: 'Hi' } })`.
 * Failures name the request and show the body, so a red test says why.
 */
export class TestResponse {
  readonly status: number
  readonly headers: Headers
  /** The body as text (UTF-8). For files, `bytes()`. */
  readonly body: string
  readonly request: { method: string; path: string }
  readonly #bytes: Uint8Array
  readonly #follow: FollowRedirect
  #followed: Promise<TestResponse> | undefined

  constructor(response: { status: number; headers: Headers; bytes: Uint8Array }, request: { method: string; path: string }, follow: FollowRedirect) {
    this.status = response.status
    this.headers = response.headers
    this.#bytes = response.bytes
    this.body = new TextDecoder().decode(response.bytes)
    this.request = request
    this.#follow = follow
  }

  /** The body parsed as JSON. */
  json<T = any>(): T {
    try {
      return JSON.parse(this.body) as T
    } catch {
      throw this.#fail(`expected a JSON body`)
    }
  }

  text(): string {
    return this.body
  }

  /** The body's exact bytes: a download, an image. */
  bytes(): Uint8Array {
    return this.#bytes
  }

  /** The Inertia page, from a visit's JSON or a first load's HTML. */
  page(): InertiaPage {
    if ((this.headers.get('content-type') ?? '').includes('json')) {
      const json = this.json<Partial<InertiaPage>>()
      if (typeof json.component === 'string') return json as InertiaPage
    }
    const match = /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/.exec(this.body)
    if (!match) throw this.#fail('expected an Inertia page (JSON with `component`, or HTML with a data-page script)')
    return JSON.parse(match[1]!) as InertiaPage
  }

  /**
   * Follows a redirect with the same client (cookies and all), e.g. to see the page a form went
   * back to. Once: flash data is shown on one visit, so later calls (and assertValidationErrors)
   * share that response.
   */
  followRedirect(): Promise<TestResponse> {
    const location = this.headers.get('location')
    if (!location || this.status < 300 || this.status >= 400) return Promise.reject(this.#fail('expected a redirect to follow'))
    return (this.#followed ??= this.#follow(location))
  }

  assertStatus(status: number): this {
    if (this.status !== status) throw this.#fail(`expected status ${status}, got ${this.status}`)
    return this
  }
  assertOk(): this {
    return this.assertStatus(200)
  }
  assertCreated(): this {
    return this.assertStatus(201)
  }
  assertNoContent(): this {
    return this.assertStatus(204)
  }
  assertNotFound(): this {
    return this.assertStatus(404)
  }
  assertForbidden(): this {
    return this.assertStatus(403)
  }
  assertUnauthorized(): this {
    return this.assertStatus(401)
  }
  assertTooManyRequests(): this {
    return this.assertStatus(429)
  }
  /** Any 2xx. */
  assertSuccessful(): this {
    if (this.status < 200 || this.status >= 300) throw this.#fail(`expected a 2xx status, got ${this.status}`)
    return this
  }

  /** A 3xx, to `to` when given (a path, or a full URL on another site). */
  assertRedirect(to?: string): this {
    if (this.status < 300 || this.status >= 400) throw this.#fail(`expected a redirect, got ${this.status}`)
    if (to !== undefined) {
      const location = this.headers.get('location') ?? ''
      const path = location.startsWith('http') && to.startsWith('/') ? new URL(location).pathname + new URL(location).search : location
      if (path !== to) throw this.#fail(`expected a redirect to ${to}, got one to ${location || '(no location)'}`)
    }
    return this
  }

  /** A file download (`content-disposition: attachment`), optionally with this filename. */
  assertDownload(filename?: string): this {
    const disposition = this.headers.get('content-disposition') ?? ''
    if (!/^attachment\b/i.test(disposition)) throw this.#fail(`expected a download (content-disposition: attachment), got ${disposition || 'none'}`)
    if (filename !== undefined) {
      const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
      const plain = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition)
      const actual = star ? decodeURIComponent(star[1]!) : plain ? plain[1]!.replace(/\\(.)/g, '$1') : undefined
      if (actual !== filename) throw this.#fail(`expected the download to be named "${filename}", got ${actual === undefined ? 'no name' : `"${actual}"`}`)
    }
    return this
  }

  assertHeader(name: string, value?: string | RegExp): this {
    const actual = this.headers.get(name)
    if (actual === null) throw this.#fail(`expected a ${name} header`)
    if (value !== undefined && !(typeof value === 'string' ? actual === value : value.test(actual))) throw this.#fail(`expected ${name}: ${String(value)}, got ${actual}`)
    return this
  }

  /** The JSON body contains `expected` (objects match by the keys given, like toMatchObject). */
  assertJson(expected: Record<string, unknown> | unknown[]): this {
    const actual = this.json()
    try {
      expect(actual).toMatchObject(expected as object)
    } catch (error) {
      throw this.#wrap(error)
    }
    return this
  }

  /** One value in the JSON body, by dot path: `assertJsonPath('post.tags.0', 'news')`. */
  assertJsonPath(path: string, expected: unknown): this {
    let value: unknown = this.json()
    for (const key of path.split('.')) value = (value as Record<string, unknown> | undefined)?.[key]
    try {
      expect(value, path).toEqual(expected)
    } catch (error) {
      throw this.#wrap(error)
    }
    return this
  }

  /**
   * An Inertia page: its component, and props containing `props` (by the keys given). Pass a
   * function to check the props yourself: `assertInertia('Posts/Index', (props) => expect(props.posts).toHaveLength(2))`.
   */
  assertInertia(component: string, props?: Record<string, unknown> | ((props: InertiaPage['props']) => void)): this {
    const page = this.page()
    if (page.component !== component) throw this.#fail(`expected the Inertia page ${component}, got ${page.component}`)
    try {
      if (typeof props === 'function') props(page.props)
      else if (props) expect(page.props).toMatchObject(props)
    } catch (error) {
      throw this.#wrap(error)
    }
    return this
  }

  /**
   * Validation failed on these fields. Works for the JSON envelope (422 with `error.fields`) and for
   * browsers (a redirect back with the errors in the session: it follows the redirect to read them).
   * `fields` is a list of names, or names to a message (string: contained in it; RegExp: matching).
   */
  async assertValidationErrors(fields: readonly string[] | Record<string, string | RegExp>): Promise<this> {
    const errors = await this.#validationErrors()
    const expected: Record<string, string | RegExp | undefined> = Array.isArray(fields) ? Object.fromEntries(fields.map((f: string) => [f, undefined])) : (fields as Record<string, string | RegExp>)
    for (const [field, message] of Object.entries(expected)) {
      const messages = errors[field]
      if (!messages?.length) throw this.#fail(`expected a validation error for "${field}"; errors were ${JSON.stringify(errors)}`)
      if (message !== undefined && !messages.some((m) => (typeof message === 'string' ? m.includes(message) : message.test(m)))) {
        throw this.#fail(`expected "${field}" to have an error ${typeof message === 'string' ? `containing "${message}"` : `matching ${message}`}; it had ${JSON.stringify(messages)}`)
      }
    }
    return this
  }

  /** No validation errors (none at all, or none for these fields). */
  async assertNoValidationErrors(fields?: readonly string[]): Promise<this> {
    const errors = await this.#validationErrors().catch(() => ({}) as Record<string, string[]>)
    const present = Object.keys(errors).filter((field) => !fields || fields.includes(field))
    if (present.length) throw this.#fail(`expected no validation errors${fields ? ` for ${fields.join(', ')}` : ''}; got ${JSON.stringify(errors)}`)
    return this
  }

  async #validationErrors(): Promise<Record<string, string[]>> {
    if (this.status === 422 && (this.headers.get('content-type') ?? '').includes('json')) {
      return (this.json<{ error?: { fields?: Record<string, string[]> } }>().error?.fields ?? {}) as Record<string, string[]>
    }
    if (this.status >= 300 && this.status < 400) {
      const page = (await this.followRedirect()).page()
      const errors = (page.props.errors ?? {}) as Record<string, string | string[]>
      return Object.fromEntries(Object.entries(errors).map(([field, value]) => [field, Array.isArray(value) ? value : [value]]))
    }
    if (this.status >= 200 && this.status < 300 && this.#isPage()) {
      const errors = (this.page().props.errors ?? {}) as Record<string, string | string[]>
      return Object.fromEntries(Object.entries(errors).map(([field, value]) => [field, Array.isArray(value) ? value : [value]]))
    }
    throw this.#fail(`expected a validation failure (422 JSON, or a redirect back with errors), got ${this.status}`)
  }

  #isPage() {
    try {
      this.page()
      return true
    } catch {
      return false
    }
  }

  #fail(message: string): Error {
    const error = new Error(`${this.request.method} ${this.request.path}: ${message}\n\nResponse ${this.status}${this.headers.get('location') ? ` → ${this.headers.get('location')}` : ''}:\n${this.body.slice(0, 2000)}`)
    error.name = 'AssertionError'
    return error
  }

  #wrap(error: unknown): Error {
    if (error instanceof Error) error.message = `${this.request.method} ${this.request.path}: ${error.message}`
    return error as Error
  }
}

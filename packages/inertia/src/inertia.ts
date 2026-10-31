import { appendHeader, isSessionStarted, previousUrl, sessionOf } from '@caldera/http'
import type { Context, MiddlewareHandler } from 'hono'
import { always, isProp, propKind, type Prop, type PropsInput } from './props.js'
import { renderOnServer, type SsrRenderer, type SsrResult } from './ssr.js'
import { escapeAttribute, type ViteAssets } from './vite.js'

/**
 * Pages, by component name. `caldera generate` fills this from `resources/pages/**` using each
 * page component's own props, so `c.render('Posts/Show', props)` is checked against the page.
 */
export interface PageRegistry {}

/** Set by codegen from `src/inertia.ts`: the props every page gets from `share`. */
export interface InertiaRegister {}

export type PageName = [keyof PageRegistry] extends [never] ? string : keyof PageRegistry & string

export type SharedProps = InertiaRegister extends { shared: infer S } ? S : {}

/** What a handler passes for a page: its props minus the shared ones and `errors`, which Caldera adds. */
export type RenderProps<K> = K extends keyof PageRegistry ? PropsInput<Omit<PageRegistry[K], keyof SharedProps | 'errors'>> : Record<string, unknown>

/** The JSON the Inertia client receives. */
export interface PageObject {
  component: string
  props: Record<string, unknown> & { errors: Record<string, unknown> }
  url: string
  version: string | null
  flash?: Record<string, unknown>
  sharedProps?: string[]
  deferredProps?: Record<string, string[]>
  clearHistory?: boolean
  encryptHistory?: boolean
}

export interface RenderOptions {
  /** Clear the client's history state (e.g. after sign-out). */
  clearHistory?: boolean
  /** Encrypt this page's history state in the browser. */
  encryptHistory?: boolean
  /** `false`: render this page in the browser only (it uses browser-only code: maps, charts, editors). */
  ssr?: boolean
}

/**
 * Adds to the HTML document of first visits: attributes on `<html>` and tags at the top of `<head>`
 * (before the stylesheets and scripts). `appearance()` is one.
 */
export interface DocumentPart {
  attributes?(c: Context): Record<string, string | undefined>
  /** Inline tags; give `<script>` and `<style>` tags the `nonce`, or the CSP blocks scripts. */
  head?(c: Context, nonce: string | undefined): string
}

export interface RootViewContext {
  page: PageObject
  /** Vite tags for the `<head>`. */
  assets: string
  /** The CSP nonce for any inline script you add. */
  nonce: string | undefined
  c: Context
  /** The server-rendered page (with `ssr` on): `head` tags, and `body` to use instead of the page script and empty app div. */
  ssr: SsrResult | null
  /** From the `document` parts: ` class="dark"`-style attributes for `<html>` (with a leading space), and tags for the top of `<head>`. */
  document: { attributes: string; head: string }
}

export interface InertiaOptions<S extends Record<string, unknown> = Record<string, unknown>> {
  /** Props every page gets, e.g. the signed-in user. Functions inside are only called when sent. */
  share?: (c: Context, page: { component: string }) => S | Promise<S>
  /** Script and style tags from `viteAssets()`; also sets the asset version. */
  assets?: ViteAssets
  /** Overrides the version from `assets`. A mismatch makes the client do a full reload. */
  version?: string | null | (() => string | null | Promise<string | null>)
  /** The HTML document for first visits. Must contain `page` as `<script data-page="app" type="application/json">`. */
  rootView?: (context: RootViewContext) => string
  /** Document `<title>` for the default root view. */
  title?: string
  /** Attributes and inline head tags for every first visit, e.g. `[appearance()]`. */
  document?: DocumentPart[]
  /**
   * Server-side rendering for first loads (Inertia visits stay JSON): `viteSsr()`. If it fails or
   * times out, the page renders on the client, as without it.
   */
  ssr?: SsrRenderer | false
}

/** What `defineInertia()` returns; also how codegen finds the shared props type. */
export interface InertiaDefinition<S extends Record<string, unknown>> {
  readonly kind: 'caldera.inertia'
  readonly options: InertiaOptions<S>
  /** The middleware: `new Hono().use(inertia.middleware())`. */
  middleware(): MiddlewareHandler
}

/** The shared props as pages receive them: wrappers and functions replaced by what they resolve to. */
export type SharedPropsOf<D> = D extends InertiaDefinition<infer S> ? { [K in keyof S]: Resolved<S[K]> } : {}

type Resolved<V> = V extends Prop<infer T> ? T : V extends (...args: never[]) => infer R ? Awaited<R> : V

declare module 'hono' {
  interface ContextRenderer {
    <K extends PageName>(component: K, props: RenderProps<K>, options?: RenderOptions): Promise<Response>
  }
}

/**
 * The server side of Inertia: put it in `src/inertia.ts` so `caldera generate` can type the shared
 * props, and add `inertia.middleware()` to the HTTP app after `startSession()`.
 */
export function defineInertia<S extends Record<string, unknown> = {}>(options: InertiaOptions<S> = {}): InertiaDefinition<S> {
  return { kind: 'caldera.inertia', options, middleware: () => inertiaMiddleware(options as InertiaOptions) }
}

const RENDERED = Symbol.for('caldera.inertia.rendered')

function inertiaMiddleware(options: InertiaOptions): MiddlewareHandler {
  const versionOf = async (): Promise<string | null> => {
    if (options.version !== undefined) return typeof options.version === 'function' ? options.version() : options.version
    return options.assets ? options.assets.version() : null
  }

  return async (c, next) => {
    const isInertia = c.req.header('x-inertia') === 'true'

    // Stale assets: tell the client to do a full page load so it picks up the new build. The version
    // is only read for Inertia visits and page renders: JSON routes never touch the asset manifest.
    if (isInertia && c.req.method === 'GET') {
      const version = await versionOf()
      if ((c.req.header('x-inertia-version') ?? '') !== (version ?? '')) {
        if (isSessionStarted(c)) sessionOf(c).reflash()
        return c.body(null, 409, { 'x-inertia-location': c.req.url, 'x-inertia-version': version ?? '' })
      }
    }

    c.setRenderer((async (component: string, props: Record<string, unknown>, renderOptions: RenderOptions = {}) =>
      render(c, options, await versionOf(), component, props, renderOptions)) as never)

    await next()
    appendVary(c)
    const res = c.res

    // Flash data and errors survive redirects until a page actually shows them.
    if (res.status >= 300 && res.status < 400 && !(c.var as Record<symbol, unknown>)[RENDERED] && isSessionStarted(c)) {
      sessionOf(c).reflash()
    }
    if (!isInertia) return

    const location = res.headers.get('location')
    if (res.status === 302 && ['PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      c.res = new Response(null, { status: 303, headers: res.headers })
    } else if (location?.includes('#') && res.status >= 300 && res.status < 400) {
      // XHR can't see a redirect's fragment, so the client performs this one itself.
      c.res = new Response(null, { status: 409, headers: { 'x-inertia-redirect': location } })
    } else if (res.status === 200 && res.body === null && !res.headers.get('content-type')) {
      // An empty response to an Inertia visit means "go back".
      c.res = new Response(null, { status: 303, headers: { location: previousUrl(c) ?? '/' } })
    }
  }
}

/** A redirect to another site or non-Inertia page. Inertia visits get a 409 the client turns into a full load. */
export function location(c: Context, url: string): Response {
  if (c.req.header('x-inertia') === 'true') return c.body(null, 409, { 'x-inertia-location': url })
  return c.redirect(url, 302)
}

async function render(c: Context, options: InertiaOptions, version: string | null, component: string, props: Record<string, unknown>, renderOptions: RenderOptions): Promise<Response> {
  c.set(RENDERED as never, true as never)
  const partial = c.req.header('x-inertia-partial-component') === component
  const only = partial ? listHeader(c, 'x-inertia-partial-data') : undefined
  const except = partial ? listHeader(c, 'x-inertia-partial-except') : undefined
  const shared = (await options.share?.(c, { component })) ?? {}
  const sessionStarted = isSessionStarted(c)

  const deferred: Record<string, string[]> = {}
  const resolved = await resolveProps({ ...shared, ...props, errors: always(() => errorsOf(c, sessionStarted)) }, '', { partial, only, except, deferred }, false)
  const flash = sessionStarted ? sessionOf(c).flashed() : {}
  const url = new URL(c.req.url)

  const page: PageObject = {
    component,
    props: resolved as PageObject['props'],
    url: url.pathname + url.search,
    version,
    ...(Object.keys(flash).length ? { flash: { ...flash } } : {}),
    ...(Object.keys(shared).length ? { sharedProps: Object.keys(shared) } : {}),
    ...(Object.keys(deferred).length ? { deferredProps: deferred } : {}),
    ...(renderOptions.clearHistory ? { clearHistory: true } : {}),
    ...(renderOptions.encryptHistory ? { encryptHistory: true } : {}),
  }

  if (c.req.header('x-inertia') === 'true') {
    return c.json(page, 200, { 'x-inertia': 'true' })
  }
  const nonce = (c.var as { secureHeadersNonce?: string }).secureHeadersNonce
  const [assets, ssr] = await Promise.all([options.assets ? options.assets.tags(nonce) : '', options.ssr && renderOptions.ssr !== false ? renderOnServer(options.ssr, page) : null])
  const document = documentOf(options.document ?? [], c, nonce)
  const html = (options.rootView ?? defaultRootView(options.title))({ page, assets, nonce, c, ssr, document })
  return c.html(html)
}

interface ResolveState {
  partial: boolean
  only: string[] | undefined
  except: string[] | undefined
  deferred: Record<string, string[]>
}

/**
 * Inertia's prop rules: on a partial reload only the requested paths (plus `always` props) are
 * computed; `optional` and `defer` props are skipped on the first load (deferred ones are listed
 * so the client fetches them next). Functions are only called for props that are sent.
 */
async function resolveProps(props: Record<string, unknown>, prefix: string, state: ResolveState, parentResolved: boolean): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  await Promise.all(
    Object.entries(props).map(async ([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key
      const wrapped = isProp(value) ? propKind(value) : undefined
      if (state.partial && wrapped !== 'always' && !parentResolved && !matchesPartial(path, state)) return
      if (!state.partial && (wrapped === 'optional' || wrapped === 'defer')) {
        if (wrapped === 'defer' && isProp(value)) (state.deferred[value.group ?? 'default'] ??= []).push(path)
        return
      }
      const result = await (isProp(value) ? value.resolve() : typeof value === 'function' ? (value as () => unknown)() : value)
      // Recurse into literal objects so nested functions resolve too; values a function returned are sent whole.
      out[key] = isPlainObject(result) ? await resolveProps(result, path, state, parentResolved || result !== value) : result
    }),
  )
  // Keep the caller's key order: Promise.all above fills `out` in completion order.
  return Object.fromEntries(Object.keys(props).filter((k) => k in out).map((k) => [k, out[k]]))
}

function matchesPartial(path: string, state: ResolveState): boolean {
  const covers = (list: string[]) => list.some((p) => path === p || path.startsWith(`${p}.`))
  if (state.only && !covers(state.only) && !state.only.some((p) => p.startsWith(`${path}.`))) return false
  if (state.except && covers(state.except)) return false
  return true
}

/** Flashed validation errors as Inertia expects them: the first message per field; named bags nested. */
function errorsOf(c: Context, sessionStarted: boolean): Record<string, unknown> {
  if (!sessionStarted) return {}
  const session = sessionOf(c)
  const first = (fields: Readonly<Record<string, string[]>>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v[0] ?? '']))
  const errors: Record<string, unknown> = first(session.errors())
  for (const bag of session.errorBags()) if (bag !== 'default') errors[bag] = first(session.errors(bag))
  return errors
}

function listHeader(c: Context, name: string): string[] | undefined {
  const value = c.req.header(name)
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function appendVary(c: Context) {
  const vary = c.res.headers.get('vary')
  if (!vary?.split(',').some((v) => v.trim().toLowerCase() === 'x-inertia')) appendHeader(c, 'vary', 'X-Inertia')
}

/** The page JSON, safe inside a `<script>`: `<` can't end the element, and line separators can't break it. */
export function serializePage(page: PageObject): string {
  return JSON.stringify(page).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

/** `lang` (and `dir` for right-to-left scripts) from @caldera/i18n's locale, matched by shape; `en` without it. */
export function htmlLang(c: Context): string {
  let locale = 'en'
  try {
    locale = (c.var as { i18n?: { locale?: string } }).i18n?.locale ?? 'en'
  } catch {
    locale = 'en'
  }
  let dir = 'ltr'
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getTextInfo?(): { direction?: string }; textInfo?: { direction?: string } }
    dir = (info.getTextInfo?.() ?? info.textInfo)?.direction ?? 'ltr'
  } catch {
    dir = 'ltr'
  }
  return `lang="${escapeAttribute(locale)}"${dir === 'rtl' ? ' dir="rtl"' : ''}`
}

/** Merges the parts' attributes (classes are combined; a later part wins for others) and head tags. */
function documentOf(parts: DocumentPart[], c: Context, nonce: string | undefined): RootViewContext['document'] {
  const attributes: Record<string, string> = {}
  for (const part of parts) {
    for (const [name, value] of Object.entries(part.attributes?.(c) ?? {})) {
      if (value === undefined) continue
      attributes[name] = name === 'class' && attributes.class ? `${attributes.class} ${value}` : value
    }
  }
  return {
    attributes: Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join(''),
    head: parts
      .map((part) => part.head?.(c, nonce) ?? '')
      .filter(Boolean)
      .join('\n    '),
  }
}

function defaultRootView(title = 'Caldera') {
  return ({ page, assets, c, nonce, ssr, document }: RootViewContext) => {
    // Scripts a page put in its <Head> run under the strict CSP only with this request's nonce.
    const head = (ssr?.head ?? []).map((tag) => (nonce && tag.startsWith('<script') && !tag.includes(' nonce=') ? tag.replace('<script', `<script nonce="${escapeAttribute(nonce)}"`) : tag))
    const hasTitle = head.some((tag) => tag.startsWith('<title'))
    return `<!doctype html>
<html ${htmlLang(c)}${document.attributes}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${document.head ? `${document.head}\n    ` : ''}${hasTitle ? '' : `<title>${escapeAttribute(title)}</title>\n    `}${[...head, ...assets.split('\n')].filter(Boolean).join('\n    ')}
  </head>
  <body>
    ${ssr ? ssr.body : `<script data-page="app" type="application/json">${serializePage(page)}</script>\n    <div id="app"></div>`}
  </body>
</html>
`
  }
}

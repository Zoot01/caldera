import { CalderaError, defineProvider, type RegisterContext } from '@caldera/core'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { createI18n, keysMatching, type Catalog, type I18n, type I18nConfig, type Translator } from './i18n.js'
import { zodErrorMap } from './zod.js'

/** Where this request's locale came from. */
export type LocaleSource = 'route' | 'user' | 'cookie' | 'header' | 'default'

/** `c.var.i18n`: this request's translator. The locale is worked out on first use, so it sees the signed-in user. */
export interface RequestI18n extends Translator {
  readonly source: LocaleSource
  /** Switches this request to `locale` and remembers it in the cookie. Unsupported locales are refused. */
  setLocale(locale: string): void
  /** The Zod error map for this locale (`@caldera/http` validation uses it). */
  zodError(issue: unknown): string | undefined
  /** What a page gets as its `i18n` prop: the locale and the messages it declared, plus the shared ones. */
  page(component?: string): { locale: string; messages: Record<string, string> }
  /** The envelope message for an error code (`errors.<code>`), when there's one. */
  errorMessage(code: string): string | undefined
}

export interface I18nOptions {
  /** `.caldera/i18n.gen.ts`'s `messages`. */
  messages: Catalog
  /** `.caldera/i18n.gen.ts`'s `pages`: each page's `export const messages = [...]`. */
  pages?: Readonly<Record<string, readonly string[]>>
  /** Messages every page gets, e.g. `['common.*']`. */
  shared?: readonly string[]
  /** The signed-in user's locale. Default: `c.var.user?.locale`, when it's a string. */
  userLocale?: (c: Context) => string | null | undefined
}

/** Works out a request's locale: route parameter, user, cookie, `Accept-Language`, default. */
export function detectLocale(i18n: I18n, c: Context, options: Pick<I18nOptions, 'userLocale'> = {}): { locale: string; source: LocaleSource } {
  const { routeParam, cookie = 'caldera_locale' } = i18n.config
  if (routeParam) {
    const found = i18n.match(c.req.param(routeParam))
    if (found) return { locale: found, source: 'route' }
  }
  const user = options.userLocale ? options.userLocale(c) : (c.var as { user?: { locale?: unknown } | null }).user?.locale
  const fromUser = i18n.match(typeof user === 'string' ? user : undefined)
  if (fromUser) return { locale: fromUser, source: 'user' }
  if (cookie) {
    const fromCookie = i18n.match(getCookie(c, cookie))
    if (fromCookie) return { locale: fromCookie, source: 'cookie' }
  }
  const fromHeader = i18n.negotiate(c.req.header('accept-language'))
  return fromHeader ? { locale: fromHeader, source: 'header' } : { locale: i18n.config.defaultLocale, source: 'default' }
}

export function requestI18n(i18n: I18n, c: Context, options: Omit<I18nOptions, 'messages'> = {}): RequestI18n {
  let state: { translator: Translator; source: LocaleSource } | undefined
  let errorMap: ((issue: unknown) => string | undefined) | undefined
  const current = () => {
    if (!state) {
      const { locale, source } = detectLocale(i18n, c, options)
      state = { translator: i18n.translator(locale), source }
      // Caches must keep one copy per language and cookie (the user's comes from the auth cookie),
      // not serve the first visitor's to everyone. Only a locale in the URL doesn't vary.
      if (source !== 'route') c.header('vary', 'Accept-Language, Cookie', { append: true })
    }
    return state
  }
  const tr = () => current().translator
  return {
    get locale() {
      return tr().locale
    },
    get source() {
      return current().source
    },
    t: ((key: string, params?: Record<string, unknown>) => (tr().t as (k: string, p?: unknown) => string)(key, params)) as Translator['t'],
    has: (key) => tr().has(key),
    number: (value, o) => tr().number(value, o),
    currency: (value, currency, o) => tr().currency(value, currency, o),
    date: (value, o) => tr().date(value, o),
    relativeTime: (value, unit, o) => tr().relativeTime(value, unit, o),
    list: (items, o) => tr().list(items, o),
    messages: (patterns) => tr().messages(patterns),
    setLocale(locale) {
      const found = i18n.match(locale)
      if (!found) throw new CalderaError('locale_unsupported', `"${locale}" isn't one of this app's locales (${i18n.config.locales.join(', ')}).`)
      state = { translator: i18n.translator(found), source: 'cookie' }
      errorMap = undefined
      const name = i18n.config.cookie ?? 'caldera_locale'
      if (name) setCookie(c, name, found, { path: '/', sameSite: 'Lax', httpOnly: false, maxAge: 60 * 60 * 24 * 365, secure: new URL(c.req.url).protocol === 'https:' })
    },
    zodError: (issue) => (errorMap ??= zodErrorMap(tr()) as (issue: unknown) => string | undefined)(issue),
    page(component) {
      const patterns = [...(options.shared ?? []), ...((component && options.pages?.[component]) || [])]
      return { locale: tr().locale, messages: patterns.length ? tr().messages(patterns) : {} }
    },
    errorMessage(code) {
      const key = `errors.${code}`
      return tr().has(key) ? (tr().t as (k: string) => string)(key) : undefined
    },
  }
}

const DEFAULT = Symbol.for('caldera.i18n.default')
const registry = globalThis as { [DEFAULT]?: I18n }

export function setDefaultI18n(i18n: I18n | undefined) {
  registry[DEFAULT] = i18n
}

export function defaultI18n(): I18n {
  const found = registry[DEFAULT]
  if (!found) throw new CalderaError('no_i18n', 'i18n isn’t configured. Add i18nProvider() to the app, or use c.var.i18n.')
  return found
}

/**
 * A translator outside a request (jobs, mail, the CLI): `translator('fr').t('posts.count', { count })`.
 * Inside one, use `c.var.i18n`, which knows the visitor's locale.
 */
export function translator(locale?: string): Translator {
  return defaultI18n().translator(locale)
}

/**
 * `i18nProvider((app) => app.config.i18n, { messages, pages })`, with both from `.caldera/i18n.gen.ts`
 * (generated from `lang/`). Adds `translations` (process-wide) and `c.var.i18n` (this request's).
 */
export function i18nProvider(resolve: (app: RegisterContext<unknown>) => I18nConfig, options: I18nOptions) {
  return defineProvider({
    name: 'i18n',
    register: (app) => {
      const translations = createI18n(resolve(app), { messages: options.messages })
      setDefaultI18n(translations)
      return { translations }
    },
    request: {
      i18n: (c, services): RequestI18n => requestI18n(services.translations, c, options),
    },
  })
}

export { keysMatching }

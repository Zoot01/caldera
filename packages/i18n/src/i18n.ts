import { CalderaError } from '@caldera/core'
import { IntlMessageFormat } from 'intl-messageformat'

/**
 * Message keys and their parameters. `caldera generate` fills this from `lang/<default locale>/*.json`:
 * `interface I18nRegister { messages: { 'posts.count': { count: number } } }`.
 */
export interface I18nRegister {}

type Messages = I18nRegister extends { messages: infer M } ? M : Record<string, Record<string, unknown>>
export type MessageKey = keyof Messages & string
export type MessageParams<K extends MessageKey> = Messages[K]
/** A message without parameters takes none; one with parameters needs all of them. */
export type TArgs<K extends MessageKey> = {} extends MessageParams<K> ? [params?: MessageParams<K>] : [params: MessageParams<K>]

/** Every locale's messages, flattened: `{ en: { 'posts.count': '{count, plural, …}' } }`. */
export type Catalog = Readonly<Record<string, Readonly<Record<string, string>>>>

export interface I18nConfig {
  /** The canonical locale: its messages are the source of truth (and of the types). */
  defaultLocale: string
  /** Locales requests may get. Others negotiate down to one of these. */
  locales: readonly string[]
  /** Explicit fallbacks, e.g. `{ 'pt-BR': 'pt', ca: 'es' }`. Then the parent locale, then the default. */
  fallbacks?: Readonly<Record<string, string | readonly string[]>>
  /**
   * `marker` (development): untranslated text shows as `⟦…⟧`, so it stands out on the page.
   * `fallback` (production, the default): the next locale in the chain, silently; a missing key shows the key.
   */
  missing?: 'marker' | 'fallback'
  /** The cookie a chosen locale is remembered in. Default `caldera_locale`; false to not use one. */
  cookie?: string | false
  /** Read the locale from this route parameter first (for `/:locale/...` routes). */
  routeParam?: string
}

export interface MissingMessage {
  key: string
  /** The locale asked for. */
  locale: string
  /** Where it was found instead, or null when no locale has it. */
  foundIn: string | null
}

/** Translates and formats for one locale. Its methods are bound, so `const { t } = c.var.i18n` works. */
export interface Translator {
  readonly locale: string
  t<K extends MessageKey>(key: K, ...args: TArgs<K>): string
  /** Whether the key has a message in this locale or one it falls back to. */
  has(key: string): boolean
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string
  currency(value: number | bigint, currency: string, options?: Intl.NumberFormatOptions): string
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
  list(items: readonly string[], options?: Intl.ListFormatOptions): string
  /**
   * The messages matching `patterns` (`posts.*`, `common.save`), resolved through the fallback chain,
   * for the client. With `missing: 'marker'`, untranslated ones come marked.
   */
  messages(patterns: readonly string[]): Record<string, string>
}

export interface I18n {
  readonly config: Required<Pick<I18nConfig, 'defaultLocale' | 'locales' | 'missing'>> & I18nConfig
  translator(locale?: string): Translator
  /** `[locale, …fallbacks, default]`, each a supported locale or one with messages. */
  chain(locale: string): string[]
  /** The best supported locale for an `Accept-Language` header, or undefined. */
  negotiate(acceptLanguage: string | undefined | null): string | undefined
  /** A supported locale for any tag (`fr-CA` → `fr`), or undefined. */
  match(locale: string | undefined | null): string | undefined
  onMissing(listener: (missing: MissingMessage) => void): () => void
  readonly catalog: Catalog
}

const canonical = (locale: string): string | undefined => {
  try {
    return Intl.getCanonicalLocales(locale)[0]
  } catch {
    return undefined
  }
}
const parents = (locale: string) => {
  const parts = locale.split('-')
  return parts.slice(1).map((_, i) => parts.slice(0, parts.length - 1 - i).join('-'))
}
const MARK = (text: string) => `⟦${text}⟧`

export function createI18n(config: I18nConfig, options: { messages: Catalog }): I18n {
  const defaultLocale = canonical(config.defaultLocale)
  if (!defaultLocale) throw new CalderaError('locale_invalid', `i18n.defaultLocale "${config.defaultLocale}" isn't a valid locale tag.`)
  const locales = config.locales.map((l) => {
    const tag = canonical(l)
    if (!tag) throw new CalderaError('locale_invalid', `i18n.locales has "${l}", which isn't a valid locale tag.`)
    return tag
  })
  if (!locales.includes(defaultLocale)) locales.unshift(defaultLocale)
  const missingMode = config.missing ?? 'fallback'
  const catalog: Record<string, Readonly<Record<string, string>>> = {}
  for (const [locale, messages] of Object.entries(options.messages)) catalog[canonical(locale) ?? locale] = messages

  const chains = new Map<string, string[]>()
  const chain = (locale: string): string[] => {
    const start = canonical(locale) ?? defaultLocale
    const cached = chains.get(start)
    if (cached) return cached
    const out: string[] = []
    const visit = (tag: string) => {
      if (out.includes(tag)) return
      out.push(tag)
      const explicit = config.fallbacks?.[tag]
      for (const next of typeof explicit === 'string' ? [explicit] : (explicit ?? [])) visit(canonical(next) ?? next)
      for (const parent of parents(tag)) visit(parent)
    }
    visit(start)
    if (!out.includes(defaultLocale)) out.push(defaultLocale)
    const result = out.filter((tag) => tag === start || locales.includes(tag) || tag in catalog)
    chains.set(start, result)
    return result
  }

  const match = (tag: string | undefined | null): string | undefined => {
    if (!tag) return undefined
    const wanted = canonical(tag)
    if (!wanted) return undefined
    if (locales.includes(wanted)) return wanted
    for (const parent of parents(wanted)) if (locales.includes(parent)) return parent
    // `en` asked, `en-US` offered.
    return locales.find((l) => l.startsWith(`${wanted}-`))
  }

  const negotiate = (header: string | undefined | null) => {
    if (!header) return undefined
    const ranges = header
      .split(',')
      .map((part, index) => {
        const [tag, ...params] = part.trim().split(';')
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
        return { tag: tag!.trim(), q: q ? Number(q.slice(2)) : 1, index }
      })
      .filter((r) => r.tag && r.tag !== '*' && Number.isFinite(r.q) && r.q > 0)
      .sort((a, b) => b.q - a.q || a.index - b.index)
    for (const range of ranges) {
      const found = match(range.tag)
      if (found) return found
    }
    return undefined
  }

  const listeners = new Set<(missing: MissingMessage) => void>()
  const reported = new Set<string>()
  const report = (missing: MissingMessage) => {
    const id = `${missing.locale}\0${missing.key}`
    if (reported.has(id)) return
    reported.add(id)
    for (const listener of listeners) listener(missing)
  }

  /** The message for a key, from the first locale in the chain that has it. */
  const lookup = (locale: string, key: string): { message: string; foundIn: string } | undefined => {
    for (const tag of chain(locale)) {
      const message = catalog[tag]?.[key]
      if (message !== undefined) return { message, foundIn: tag }
    }
    return undefined
  }

  const formats = new Map<string, IntlMessageFormat>()
  const formatterFor = (foundIn: string, key: string, message: string) => {
    const id = `${foundIn}\0${key}`
    let formatter = formats.get(id)
    if (!formatter) {
      try {
        formatter = new IntlMessageFormat(message, foundIn)
      } catch (error) {
        throw new CalderaError('message_invalid', `Message "${key}" (${foundIn}) isn't valid ICU: ${(error as Error).message}`)
      }
      formats.set(id, formatter)
    }
    return formatter
  }

  const translators = new Map<string, Translator>()
  const translator = (requested = defaultLocale): Translator => {
    const locale = canonical(requested) ?? defaultLocale
    const existing = translators.get(locale)
    if (existing) return existing
    const nf = new Map<string, Intl.NumberFormat>()
    const df = new Map<string, Intl.DateTimeFormat>()
    const cachedNumber = (options?: Intl.NumberFormatOptions) => {
      const id = JSON.stringify(options ?? {})
      let f = nf.get(id)
      if (!f) nf.set(id, (f = new Intl.NumberFormat(locale, options)))
      return f
    }
    const t = (key: string, params?: Record<string, unknown>): string => {
      const found = lookup(locale, key)
      if (!found) {
        report({ key, locale, foundIn: null })
        return missingMode === 'marker' ? MARK(key) : key
      }
      if (found.foundIn !== locale) report({ key, locale, foundIn: found.foundIn })
      let text: string
      try {
        const out = formatterFor(found.foundIn, key, found.message).format(params as never)
        text = Array.isArray(out) ? out.join('') : String(out)
      } catch (error) {
        if (error instanceof CalderaError) throw error
        throw new CalderaError('message_format_failed', `Couldn't format "${key}" (${found.foundIn}): ${(error as Error).message}`, { key, locale: found.foundIn })
      }
      return missingMode === 'marker' && found.foundIn !== locale && !sameLanguageFallback(locale, found.foundIn) ? MARK(text) : text
    }
    const result: Translator = {
      locale,
      t: t as Translator['t'],
      has: (key) => lookup(locale, key) !== undefined,
      number: (value, options) => cachedNumber(options).format(value),
      currency: (value, currency, options) => cachedNumber({ style: 'currency', currency, ...options }).format(value),
      date: (value, options) => {
        const id = JSON.stringify(options ?? {})
        let f = df.get(id)
        if (!f) df.set(id, (f = new Intl.DateTimeFormat(locale, options)))
        return f.format(value)
      },
      relativeTime: (value, unit, options) => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', ...options }).format(value, unit),
      list: (items, options) => new Intl.ListFormat(locale, options).format(items),
      messages(patterns) {
        const keys = keysMatching(Object.keys(catalog[defaultLocale] ?? {}), patterns)
        const out: Record<string, string> = {}
        for (const key of keys) {
          const found = lookup(locale, key)
          if (!found) out[key] = MARK(key)
          // The marker wraps the ICU source; ⟦ and ⟧ are plain text to ICU.
          else out[key] = missingMode === 'marker' && found.foundIn !== locale && !sameLanguageFallback(locale, found.foundIn) ? MARK(found.message) : found.message
        }
        return out
      },
    }
    translators.set(locale, result)
    return result
  }

  return {
    config: { ...config, defaultLocale, locales, missing: missingMode },
    translator,
    chain,
    negotiate,
    match,
    onMissing(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    catalog,
  }
}

/** `en-GB` reading `en` isn't untranslated, just not specialised. */
function sameLanguageFallback(locale: string, foundIn: string) {
  return locale.startsWith(`${foundIn}-`)
}

/** Keys matching `posts.*` (everything under `posts.`), `*` (all), or exact keys. */
export function keysMatching(keys: readonly string[], patterns: readonly string[]): string[] {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const pattern of patterns) {
    if (pattern === '*') return [...keys]
    if (pattern.endsWith('.*')) prefixes.push(pattern.slice(0, -1))
    else exact.add(pattern)
  }
  return keys.filter((key) => exact.has(key) || prefixes.some((p) => key.startsWith(p)))
}

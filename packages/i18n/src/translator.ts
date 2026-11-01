import { IntlMessageFormat } from 'intl-messageformat'
import { createElement, Fragment, type ReactNode } from 'react'
import type { MessageKey, MessageParams, TArgs } from './i18n.js'

// Formats messages a page was sent, with React nodes for their tags. No Inertia here, so Next.js
// Server Components (and anything else) can use it: `createClientTranslator({ locale, messages })`.

/** What `c.var.i18n.page(component)` sends: put it in `share` as `i18n`. */
export interface PageI18n {
  locale: string
  messages: Record<string, string>
}

/** A message's parameters with its tags (`<b>…</b>`) rendering React nodes instead of strings. */
export type RichParams<P> = { [K in keyof P]: P[K] extends (chunks: string[]) => string ? (chunks: ReactNode[]) => ReactNode : P[K] }

export interface ClientTranslator {
  readonly locale: string
  t<K extends MessageKey>(key: K, ...args: TArgs<K>): string
  /** For messages with tags: `rich('home.edit', { code: (c) => <code>{c}</code> })`. Translators keep the markup's place in the sentence. */
  rich<K extends MessageKey>(key: K, ...args: {} extends MessageParams<K> ? [params?: RichParams<MessageParams<K>>] : [params: RichParams<MessageParams<K>>]): ReactNode
  has(key: string): boolean
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string
  currency(value: number | bigint, currency: string, options?: Intl.NumberFormatOptions): string
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
  list(items: readonly string[], options?: Intl.ListFormatOptions): string
}

// Shared across renders and pages: a message is parsed once per locale.
const formats = new Map<string, IntlMessageFormat>()
const warned = new Set<string>()

/** A translator over the messages a page was sent. No catalogue ships in the bundle. */
export function createClientTranslator(i18n: PageI18n): ClientTranslator {
  const { locale, messages } = i18n
  const format = (key: string, params?: Record<string, unknown>): unknown => {
    const message = messages[key]
    if (message === undefined) {
      // Not declared by this page: add it to the page's `export const messages = [...]` (or `shared`).
      if (!warned.has(key)) {
        warned.add(key)
        console.warn(`[caldera] "${key}" wasn't sent to this page. Add it (or its namespace) to the page's \`export const messages\`.`)
      }
      return `⟦${key}⟧`
    }
    const id = `${locale}\0${key}\0${message}`
    let formatter = formats.get(id)
    if (!formatter) formats.set(id, (formatter = new IntlMessageFormat(message, locale)))
    return formatter.format(params as never)
  }
  const t = (key: string, params?: Record<string, unknown>) => {
    const out = format(key, params)
    return Array.isArray(out) ? out.join('') : String(out)
  }
  const rich = (key: string, params?: Record<string, unknown>): ReactNode => {
    const out = format(key, params)
    // Children as arguments, not an array, so React doesn't ask for keys.
    return Array.isArray(out) ? createElement(Fragment, null, ...(out as ReactNode[])) : (out as ReactNode)
  }
  return {
    locale,
    t: t as ClientTranslator['t'],
    rich: rich as ClientTranslator['rich'],
    has: (key) => key in messages,
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    currency: (value, currency, options) => new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value),
    date: (value, options) => new Intl.DateTimeFormat(locale, options).format(value),
    relativeTime: (value, unit, options) => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', ...options }).format(value, unit),
    list: (items, options) => new Intl.ListFormat(locale, options).format(items),
  }
}

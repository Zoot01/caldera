import { usePage } from '@inertiajs/react'
import { IntlMessageFormat } from 'intl-messageformat'
import { useMemo } from 'react'
import type { MessageKey, TArgs } from './i18n.js'

/** What `c.var.i18n.page(component)` sends: put it in `share` as `i18n`. */
export interface PageI18n {
  locale: string
  messages: Record<string, string>
}

export interface ClientTranslator {
  readonly locale: string
  t<K extends MessageKey>(key: K, ...args: TArgs<K>): string
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
  const t = (key: string, params?: Record<string, unknown>) => {
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
    const out = formatter.format(params as never)
    return Array.isArray(out) ? out.join('') : String(out)
  }
  return {
    locale,
    t: t as ClientTranslator['t'],
    has: (key) => key in messages,
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    currency: (value, currency, options) => new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value),
    date: (value, options) => new Intl.DateTimeFormat(locale, options).format(value),
    relativeTime: (value, unit, options) => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', ...options }).format(value, unit),
    list: (items, options) => new Intl.ListFormat(locale, options).format(items),
  }
}

/** `const { t } = useT()` in a page or component: typed keys, the page's locale. Reads the `i18n` shared prop. */
export function useT(): ClientTranslator {
  const { i18n } = usePage<{ i18n?: PageI18n }>().props
  if (!i18n) throw new Error('useT() needs the `i18n` shared prop: add `i18n: c.var.i18n.page(component)` to `share` in src/inertia.ts.')
  return useMemo(() => createClientTranslator(i18n), [i18n])
}

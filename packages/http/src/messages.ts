/** What @caldera-js/i18n's `c.var.i18n` gives these helpers (matched by shape: no dependency). */
export interface MessageTranslator {
  has(key: string): boolean
  t(key: string, params?: Record<string, unknown>): string
}

// `ns.key`: a message key, as opposed to a sentence (which has spaces).
const MESSAGE_KEY = /^[\w-]+(\.[\w-]+)+$/

/** The translation when `message` is a message key the request's locale has; otherwise `message` as written. */
export function translateMessage(message: string, i18n: Partial<MessageTranslator> | undefined, params?: Record<string, unknown>): string {
  if (!i18n?.has || !i18n.t || !MESSAGE_KEY.test(message) || !i18n.has(message)) return message
  return i18n.t(message, params)
}

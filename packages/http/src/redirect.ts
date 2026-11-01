import type { Context } from 'hono'
import { isSessionStarted, sessionOf } from './session.js'

/** Session key for the page a signed-out visitor was headed to. */
export const INTENDED_KEY = 'url.intended'

/** A redirect that can flash to the session on its way out: `back(c).with('success', 'Saved')`. */
export class Redirect extends Response {
  readonly #c: Context

  constructor(c: Context, location: string, status: 301 | 302 | 303 | 307 | 308) {
    // With the headers already set on the context (a cookie from setCookie, a Vary), as c.redirect()
    // keeps them: a Response of its own would drop them.
    super(null, { status, headers: c.newResponse(null, status, { location }).headers })
    this.#c = c
  }

  with(key: string, value: unknown): this
  with(values: Record<string, unknown>): this
  with(keyOrValues: string | Record<string, unknown>, value?: unknown): this {
    const session = sessionOf(this.#c)
    if (typeof keyOrValues === 'string') session.flash(keyOrValues, value)
    else for (const [key, item] of Object.entries(keyOrValues)) session.flash(key, item)
    return this
  }

  /** Validation errors for the next page, `{ title: ['Too short'] }`. With Inertia they become `props.errors`. */
  withErrors(fields: Record<string, string | string[]>, bag?: string): this {
    const normalized = Object.fromEntries(Object.entries(fields).map(([key, messages]) => [key, Array.isArray(messages) ? messages : [messages]]))
    sessionOf(this.#c).flashErrors(normalized, bag)
    return this
  }

  /** Flashes the submitted form (minus passwords and files) so a plain HTML form can be refilled. */
  withInput(input: Record<string, unknown>): this {
    sessionOf(this.#c).flashInput(input)
    return this
  }
}

/**
 * Redirects to a path or URL. After anything but GET/HEAD it uses 303, so the browser follows
 * with a GET (what Inertia requires after PUT, PATCH and DELETE, and right for POST too).
 */
export function redirect(c: Context, to: string, status?: 301 | 302 | 303 | 307 | 308): Redirect {
  return new Redirect(c, to, status ?? (c.req.method === 'GET' || c.req.method === 'HEAD' ? 302 : 303))
}

/** Back to the page the request came from (same-origin Referer only), or `fallback`. */
export function back(c: Context, options: { fallback?: string } = {}): Redirect {
  return redirect(c, previousUrl(c) ?? options.fallback ?? '/')
}

/** The same-origin Referer as a path, or undefined. Never redirects to another site. */
export function previousUrl(c: Context): string | undefined {
  const referer = c.req.header('referer')
  if (!referer) return undefined
  try {
    const from = new URL(referer)
    const own = new URL(c.req.url)
    return from.origin === own.origin ? `${from.pathname}${from.search}${from.hash}` : undefined
  } catch {
    return undefined
  }
}

/**
 * After sign-in: back to the page that sent the visitor to the login page, or `fallback`. Only paths
 * on this site are followed, so a tampered value can't redirect elsewhere.
 */
export function intended(c: Context, fallback = '/'): Redirect {
  const stored = isSessionStarted(c) ? sessionOf(c).pull<string>(INTENDED_KEY) : undefined
  const safe = typeof stored === 'string' && stored.startsWith('/') && !stored.startsWith('//') && !stored.startsWith('/\\')
  return redirect(c, safe ? stored : fallback)
}

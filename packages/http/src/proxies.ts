import type { Context, MiddlewareHandler } from 'hono'

/**
 * Behind a proxy (Caddy, nginx, a load balancer), every request arrives from the proxy's address, over
 * plain HTTP. `trustProxies()` reads the client's from the proxy's headers, only when the request
 * came from a proxy you trust, as Laravel's TrustProxies does:
 *
 * - `c.var.ip`: the client's address, from `X-Forwarded-For` (rate limits key on it: `ipOf()`, and
 *   Better Auth's through `authRoutes()`).
 * - `X-Forwarded-Proto: https` makes the request secure, so `Secure` cookies stay `Secure`.
 *
 * `proxies`: addresses to trust, `'loopback'` (the default: a proxy on the same machine) among them, or
 * `'*'` for any, on a platform whose edge sets these headers itself (Vercel); or a function of the request
 * that gives one of those. On Workers, Cloudflare's
 * `cf-connecting-ip` is used without this.
 */
type Proxies = '*' | readonly string[]

export function trustProxies(options: { proxies?: Proxies | ((c: Context) => Proxies | undefined) } = {}): MiddlewareHandler {
  const trusting = (listed: Proxies) => (address: string | undefined) => {
    if (listed === '*') return true
    if (!address) return false
    const bare = address.replace(/^::ffff:/, '')
    return listed.some((entry) => (entry === 'loopback' ? bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.') : entry === bare))
  }
  return async (c, next) => {
    // A function reads it per request, e.g. from config: `(c) => c.var.config.app.trustedProxies`.
    const listed = (typeof options.proxies === 'function' ? options.proxies(c) : options.proxies) ?? ['loopback']
    const trusts = trusting(listed)
    const peer = socketAddress(c)
    if (trusts(peer)) {
      // Right to left: each proxy appends who it heard from; the first address not of a trusted proxy is
      // the client (anything further left could have been sent by them).
      const chain = (c.req.header('x-forwarded-for') ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      const client = [...chain].reverse().find((address) => !trusts(address) || listed === '*') ?? chain[0]
      if (client) c.set('ip' as never, client as never)
      if (c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') c.set('secure' as never, true as never)
    }
    await next()
  }
}

/** The address the request came from, on Node (`@hono/node-server`); undefined on fetch runtimes. */
function socketAddress(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
}

/** Whether the request reached the app over HTTPS: its URL, or a trusted proxy's `X-Forwarded-Proto`. */
export function isSecure(c: Context): boolean {
  return (c.var as { secure?: unknown }).secure === true || new URL(c.req.url).protocol === 'https:'
}

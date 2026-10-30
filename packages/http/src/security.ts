import type { MiddlewareHandler } from 'hono'
import { secureHeaders, type NONCE } from 'hono/secure-headers'
import { ForbiddenError } from './errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface OriginCheckOptions {
  /** Origins allowed to send state-changing requests, e.g. `[env.APP_URL]`. The request's own origin is always allowed. */
  trustedOrigins?: string[]
  /** Accept `Sec-Fetch-Site: same-site` (sibling subdomains). Off by default. */
  allowSameSite?: boolean
  /** Skip the check, e.g. for webhook routes that authenticate by signature. */
  exempt?: (path: string) => boolean
}

/**
 * CSRF protection without tokens, the approach Laravel 13 (`useOriginOnly`) and Better Auth use:
 * 1. Safe methods pass.
 * 2. `Sec-Fetch-Site: same-origin` passes (`same-site` only if allowed); any other value fails.
 * 3. Without Fetch Metadata, `Origin` (or `Referer`) must be trusted.
 * 4. With neither header, only requests without cookies pass (non-browser clients).
 * Pair with `SameSite=Lax` cookies.
 */
export function originCheck(options: OriginCheckOptions = {}): MiddlewareHandler {
  const trusted = new Set((options.trustedOrigins ?? []).map((o) => new URL(o).origin))

  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || options.exempt?.(c.req.path)) return next()

    const own = new URL(c.req.url).origin
    const site = c.req.header('sec-fetch-site')
    if (site) {
      if (site === 'same-origin' || (site === 'same-site' && options.allowSameSite)) return next()
      throw new ForbiddenError('Cross-site request blocked.', 'csrf_failed')
    }

    const origin = c.req.header('origin') ?? originOf(c.req.header('referer'))
    if (origin) {
      if (origin === own || trusted.has(origin)) return next()
      throw new ForbiddenError('Cross-site request blocked.', 'csrf_failed')
    }

    if (c.req.header('cookie')) throw new ForbiddenError('Cross-site request blocked.', 'csrf_failed')
    return next()
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

export interface SecurityHeadersOptions {
  /** Send HSTS. Turn on in production behind HTTPS. */
  hsts?: boolean
  /** Content-Security-Policy directives (Hono format). Use `NONCE` for per-request script nonces. */
  csp?: Record<string, (string | typeof NONCE)[]>
  /** Report CSP violations without enforcing. */
  cspReportOnly?: boolean
}

/** Secure defaults, on by default (unlike AdonisJS Shield): nosniff, no framing, strict referrer, COOP. */
export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  return secureHeaders({
    xContentTypeOptions: 'nosniff',
    xFrameOptions: 'DENY',
    referrerPolicy: 'strict-origin-when-cross-origin',
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-origin',
    strictTransportSecurity: options.hsts ? 'max-age=31536000; includeSubDomains' : false,
    xXssProtection: false,
    ...(options.csp
      ? options.cspReportOnly
        ? { contentSecurityPolicyReportOnly: { frameAncestors: ["'none'"], ...options.csp } }
        : { contentSecurityPolicy: { frameAncestors: ["'none'"], ...options.csp } }
      : {}),
  } as Parameters<typeof secureHeaders>[0])
}

import { redirect, UnauthenticatedError, defineMiddleware } from '@caldera/http'
import type { RegisteredHonoEnv } from '@caldera/core'
import type { Context as HonoContext, Next } from 'hono'

// Every request already knows its user (authenticate() in src/http.ts sets c.var.user, or null).
type Context = HonoContext<RegisteredHonoEnv>
const PASSWORD_CONFIRMED_AT = 'auth.password_confirmed_at'

/** Named middleware for routes: `{ middleware: [mw.auth(), mw.verified()] }`. */
export const mw = defineMiddleware({
  // Signed in. Otherwise a 401: page visits go to /login, and come back here after signing in.
  auth: () => async (c: Context, next: Next) => {
    if (!c.var.user) throw new UnauthenticatedError()
    await next()
  },
  // Signed out (the login and register pages): signed-in people go home.
  guest: () => async (c: Context, next: Next) => {
    if (c.var.user) return redirect(c, c.var.config.auth.home)
    await next()
  },
  // With `mustVerifyEmail` (src/config/auth.ts): unverified people go to /verify-email first.
  verified: () => async (c: Context, next: Next) => {
    if (c.var.config.auth.mustVerifyEmail && c.var.user && !c.var.user.emailVerified) return redirect(c, '/verify-email')
    await next()
  },
  // The password typed within `passwordTimeoutSeconds` (sensitive settings: Security). Otherwise
  // /confirm-password first, then back here.
  passwordConfirmed: () => async (c: Context, next: Next) => {
    if (!passwordConfirmed(c)) {
      if (c.req.method === 'GET') c.var.session.put('url.intended', c.req.path)
      return redirect(c, '/confirm-password')
    }
    await next()
  },
})

/** Records a fresh password confirmation: POST /confirm-password, and signing in with the password. */
export function confirmPassword(c: Context) {
  c.var.session.put(PASSWORD_CONFIRMED_AT, Date.now())
}

/** Was the password typed within `passwordTimeoutSeconds`? */
export function passwordConfirmed(c: Context) {
  const at = c.var.session.get<number>(PASSWORD_CONFIRMED_AT)
  return at !== undefined && Date.now() - at <= c.var.config.auth.passwordTimeoutSeconds * 1000
}

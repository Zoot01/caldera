import { withAuthCookies } from '@caldera/auth'
import { defineLimiter, ipOf, perMinute } from '@caldera/cache'
import { back, defineRequest, defineRoutes, intended, redirect, ValidationError } from '@caldera/http'
import { z } from 'zod'
import { confirmPassword, mw } from '../middleware.js'

// Sign-up, sign-in, passwords and email verification. The pages are in resources/pages/auth; each
// form posts here, and these call Better Auth on the server (`c.var.auth.api`, configured in src/auth.ts).

const email = z.email('Enter a valid email address.').transform((value) => value.trim().toLowerCase())
const newPassword = z.string().min(8, 'Use at least 8 characters.').max(128, 'Use at most 128 characters.')
const matches = (form: { password: string; passwordConfirmation: string }) => form.password === form.passwordConfirmation
const mismatch = { message: 'The passwords don’t match.', path: ['passwordConfirmation'] }

const Register = defineRequest({
  body: z
    .object({ name: z.string().trim().min(1, 'Enter your name.').max(255), email, password: newPassword, passwordConfirmation: z.string() })
    .refine(matches, mismatch),
})
const Login = defineRequest({ body: z.object({ email, password: z.string().min(1, 'Enter your password.'), remember: z.boolean().default(false) }) })
const ForgotPassword = defineRequest({ body: z.object({ email }) })
const ResetPassword = defineRequest({
  body: z.object({ token: z.string().min(1), password: newPassword, passwordConfirmation: z.string() }).refine(matches, mismatch),
})
const ConfirmPassword = defineRequest({ body: z.object({ password: z.string().min(1, 'Enter your password.') }) })
const TwoFactorChallenge = defineRequest({
  body: z.object({ code: z.string().trim().optional(), recoveryCode: z.string().trim().optional(), remember: z.boolean().default(false) }),
})

// Five failed attempts a minute per email and address; a success doesn't count.
const login = defineLimiter('login', {
  limits: [perMinute(5)],
  count: 'failures',
  key: async (c) => [ipOf(c), String(((await c.req.json().catch(() => ({}))) as { email?: unknown }).email ?? '').toLowerCase()],
  message: 'Too many sign-in attempts. Try again in a minute.',
})

// Five codes a minute per address, on top of Better Auth's own lockout (ten wrong codes lock the account).
const twoFactor = defineLimiter('two-factor', { limits: [perMinute(5)], count: 'failures', message: 'Too many attempts. Try again in a minute.' })

const headers = (c: { req: { raw: Request } }) => c.req.raw.headers
// Better Auth's cookie between the password and the second factor (10 minutes).
const inTwoFactorChallenge = (c: { req: { header(name: string): string | undefined } }) => /(?:^|;\s*)(?:__Secure-)?better-auth\.two_factor=/.test(c.req.header('cookie') ?? '')

export const auth = defineRoutes('auth')
  .get('register', '/register', { middleware: [mw.guest()] }, (c) => c.render('auth/Register', {}))
  .post('register.store', '/register', { middleware: [mw.guest()], request: Register }, async (c) => {
    const { name, email, password } = c.req.valid('json')
    const res = await c.var.auth.api.signUpEmail({ body: { name, email, password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ email: ['This email address is already registered.'] })
    // With mustVerifyEmail, Better Auth signs people in only once they've clicked the link.
    if (c.var.config.auth.mustVerifyEmail) return redirect(c, '/login').with('status', 'Check your inbox: click the link we sent to confirm your email, then sign in.')
    confirmPassword(c)
    return withAuthCookies(c, res, redirect(c, c.var.config.auth.home))
  })
  .get('login', '/login', { middleware: [mw.guest()] }, (c) => c.render('auth/Login', { canResetPassword: true, canRegister: true, passkeys: c.var.config.auth.passkeys }))
  .post('login.store', '/login', { middleware: [mw.guest()], throttle: login, request: Login }, async (c) => {
    const { email, password, remember } = c.req.valid('json')
    const res = await c.var.auth.api.signInEmail({ body: { email, password, rememberMe: remember }, headers: headers(c), asResponse: true })
    if (res.status === 403) throw new ValidationError({ email: ['Confirm your email address first: we’ve sent you a new link.'] })
    if (!res.ok) throw new ValidationError({ email: ['These credentials don’t match our records.'] })
    // Two-factor on: the password was right, and Better Auth wants the second factor before signing in.
    if (((await res.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect) return withAuthCookies(c, res, redirect(c, '/two-factor-challenge'))
    // The password was just typed: sensitive settings don't ask for it again (mw.passwordConfirmed()).
    confirmPassword(c)
    return withAuthCookies(c, res, intended(c, c.var.config.auth.home))
  })
  // Where the browser goes after signing in with a passkey (Better Auth's endpoint set the session).
  .get('login.redirect', '/login/redirect', { middleware: [mw.auth()] }, (c) => intended(c, c.var.config.auth.home))
  .get('two-factor.login', '/two-factor-challenge', { middleware: [mw.guest()] }, (c) => {
    if (!inTwoFactorChallenge(c)) return redirect(c, '/login')
    return c.render('auth/TwoFactorChallenge', {})
  })
  .post('two-factor.login.store', '/two-factor-challenge', { middleware: [mw.guest()], throttle: twoFactor, request: TwoFactorChallenge }, async (c) => {
    if (!inTwoFactorChallenge(c)) return redirect(c, '/login').with('status', 'That sign-in took too long. Please sign in again.')
    const { code, recoveryCode, remember } = c.req.valid('json')
    // `remember`: this browser skips the second factor for 30 days.
    const res = recoveryCode
      ? await c.var.auth.api.verifyBackupCode({ body: { code: recoveryCode, trustDevice: remember }, headers: headers(c), asResponse: true })
      : await c.var.auth.api.verifyTOTP({ body: { code: code ?? '', trustDevice: remember }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError(recoveryCode ? { recoveryCode: ['That recovery code is invalid or used.'] } : { code: ['That code is invalid.'] })
    // Signed in with the password and a second factor.
    confirmPassword(c)
    return withAuthCookies(c, res, intended(c, c.var.config.auth.home))
  })
  .post('logout', '/logout', { middleware: [mw.auth()] }, async (c) => {
    const res = await c.var.auth.api.signOut({ headers: headers(c), asResponse: true })
    return withAuthCookies(c, res, redirect(c, '/'))
  })

  .get('password.request', '/forgot-password', { middleware: [mw.guest()] }, (c) => c.render('auth/ForgotPassword', {}))
  .post('password.email', '/forgot-password', { middleware: [mw.guest()], request: ForgotPassword }, async (c) => {
    // The same answer whether or not the address has an account, so this can't be used to find accounts.
    await c.var.auth.api.requestPasswordReset({ body: { email: c.req.valid('json').email, redirectTo: '/reset-password' }, headers: headers(c) })
    return back(c).with('status', 'If that address has an account, we’ve emailed it a link to reset the password.')
  })
  // Better Auth checks the emailed link at /api/auth/reset-password/:token and sends people here with it.
  .get('password.reset', '/reset-password', { middleware: [mw.guest()] }, (c) => {
    const token = c.req.query('token')
    if (!token || c.req.query('error')) return redirect(c, '/forgot-password').with('status', 'That reset link is invalid or has expired. Ask for a new one.')
    return c.render('auth/ResetPassword', { token })
  })
  .post('password.store', '/reset-password', { middleware: [mw.guest()], request: ResetPassword }, async (c) => {
    const { token, password } = c.req.valid('json')
    const res = await c.var.auth.api.resetPassword({ body: { token, newPassword: password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That reset link is invalid or has expired. Ask for a new one.'] })
    return redirect(c, '/login').with('status', 'Your password has been reset. Sign in with the new one.')
  })

  .get('verification.notice', '/verify-email', { middleware: [mw.auth()] }, (c) => {
    if (c.var.user!.emailVerified) return redirect(c, c.var.config.auth.home)
    return c.render('auth/VerifyEmail', {})
  })
  .post('verification.send', '/email/verification-notification', { middleware: [mw.auth()] }, async (c) => {
    if (c.var.user!.emailVerified) return redirect(c, c.var.config.auth.home)
    await c.var.auth.api.sendVerificationEmail({ body: { email: c.var.user!.email, callbackURL: c.var.config.auth.home }, headers: headers(c) })
    return back(c).with('status', 'verification-link-sent')
  })

  .get('password.confirm', '/confirm-password', { middleware: [mw.auth()] }, (c) => c.render('auth/ConfirmPassword', {}))
  .post('password.confirm.store', '/confirm-password', { middleware: [mw.auth()], request: ConfirmPassword }, async (c) => {
    const res = await c.var.auth.api.verifyPassword({ body: { password: c.req.valid('json').password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That password is incorrect.'] })
    confirmPassword(c)
    return intended(c, c.var.config.auth.home)
  })

import { withAuthCookies } from '@caldera/auth'
import { back, defineRequest, defineRoutes, NotFoundError, redirect, ValidationError } from '@caldera/http'
import type { Context } from 'hono'
import { renderSVG } from 'uqr'
import { z } from 'zod'
import { mw } from '../middleware.js'

// The signed-in person's own account. Pages are in resources/pages/settings.

const Profile = defineRequest({
  body: z.object({ name: z.string().trim().min(1, 'Enter your name.').max(255), email: z.email('Enter a valid email address.').transform((value) => value.trim().toLowerCase()) }),
})
const Password = defineRequest({
  body: z
    .object({
      currentPassword: z.string().min(1, 'Enter your current password.'),
      password: z.string().min(8, 'Use at least 8 characters.').max(128, 'Use at most 128 characters.'),
      passwordConfirmation: z.string(),
    })
    .refine((form) => form.password === form.passwordConfirmation, { message: 'The passwords don’t match.', path: ['passwordConfirmation'] }),
})
const DeleteAccount = defineRequest({ body: z.object({ password: z.string().min(1, 'Enter your password.') }) })
// Turning two-factor on and off, and new recovery codes, need the password (Better Auth checks it).
const WithPassword = defineRequest({ body: z.object({ password: z.string().min(1, 'Enter your password.') }) })
const ConfirmTwoFactor = defineRequest({ body: z.object({ code: z.string().trim().min(1, 'Enter the code from your app.') }) })

// Between "turn on" and the first code: the authenticator app's link and the recovery codes, in the
// (encrypted) session. Nothing is enabled until the person proves their app works.
const SETUP = 'auth.two_factor_setup'
interface Setup {
  uri: string
  recoveryCodes: string[]
}

/** 404 for a feature turned off in src/config/auth.ts. */
const feature = (name: 'twoFactor' | 'passkeys') => (c: Context) => {
  if (!(c.var.config as { auth: Record<string, unknown> }).auth[name]) throw new NotFoundError()
  return true
}

const headers = (c: { req: { raw: Request } }) => c.req.raw.headers

export const settings = defineRoutes('settings', { prefix: '/settings', middleware: [mw.auth(), mw.verified()] })
  .get('index', '/', (c) => redirect(c, '/settings/profile'))
  .get('profile', '/profile', (c) => c.render('settings/Profile', { mustVerifyEmail: c.var.config.auth.mustVerifyEmail }))
  .patch('profile.update', '/profile', { request: Profile }, async (c) => {
    const { name, email } = c.req.valid('json')
    const user = c.var.user!
    // The email first: if it's refused, nothing has been saved behind the error. (An address someone else
    // has isn't refused: Better Auth answers as if it worked and changes nothing, so accounts can't be found.)
    let response = back(c).with('status', 'profile-updated')
    if (email !== user.email) {
      // Better Auth changes an unverified address at once; a verified one only after the new address confirms.
      const res = await c.var.auth.api.changeEmail({ body: { newEmail: email, callbackURL: '/settings/profile' }, headers: headers(c), asResponse: true })
      if (!res.ok) throw new ValidationError({ email: ['That email address can’t be used.'] })
      response = withAuthCookies(c, res, back(c).with('status', user.emailVerified ? 'email-change-sent' : 'profile-updated'))
    }
    if (name !== user.name) {
      const res = await c.var.auth.api.updateUser({ body: { name }, headers: headers(c), asResponse: true })
      if (!res.ok) throw new ValidationError({ name: ['Your name couldn’t be saved. Try again.'] })
      withAuthCookies(c, res, response)
    }
    return response
  })
  .delete('profile.destroy', '/profile', { request: DeleteAccount }, async (c) => {
    const res = await c.var.auth.api.deleteUser({ body: { password: c.req.valid('json').password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That password is incorrect.'] })
    return withAuthCookies(c, res, redirect(c, '/'))
  })
  .get('security', '/security', { middleware: [mw.passwordConfirmed()] }, async (c) => {
    const { twoFactor, passkeys } = c.var.config.auth
    const setup = c.var.session.get<Setup>(SETUP)
    const uri = setup && !c.var.user!.twoFactorEnabled ? setup.uri : null
    return c.render('settings/Security', {
      twoFactor: twoFactor
        ? {
            enabled: c.var.user!.twoFactorEnabled,
            // While setting up: the QR code to scan, and the key to type in instead.
            setup: uri ? { qr: renderSVG(uri, { border: 1 }), key: new URL(uri).searchParams.get('secret') ?? '' } : null,
          }
        : null,
      passkeys: passkeys
        ? (await c.var.auth.api.listPasskeys({ headers: headers(c) })).map((p) => ({ id: p.id, name: p.name ?? 'Passkey', createdAt: new Date(p.createdAt).toISOString() }))
        : null,
    })
  })
  .post('two-factor.enable', '/two-factor', { authorize: feature('twoFactor'), request: WithPassword }, async (c) => {
    const res = await c.var.auth.api.enableTwoFactor({ body: { password: c.req.valid('json').password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That password is incorrect.'] })
    const { totpURI, backupCodes } = (await res.json()) as { totpURI: string; backupCodes: string[] }
    c.var.session.put(SETUP, { uri: totpURI, recoveryCodes: backupCodes } satisfies Setup)
    return back(c)
  })
  .post('two-factor.confirm', '/two-factor/confirm', { authorize: feature('twoFactor'), request: ConfirmTwoFactor }, async (c) => {
    const setup = c.var.session.get<Setup>(SETUP)
    if (!setup) return back(c)
    // The first right code turns two-factor on (and Better Auth issues a fresh session).
    const res = await c.var.auth.api.verifyTOTP({ body: { code: c.req.valid('json').code }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ code: ['That code is invalid. Check the time on your device, and try the newest one.'] })
    c.var.session.forget(SETUP)
    // Shown once, right now: they're stored hashed.
    return withAuthCookies(c, res, back(c).with({ status: 'two-factor-enabled', recoveryCodes: setup.recoveryCodes }))
  })
  .delete('two-factor.setup.cancel', '/two-factor/setup', { authorize: feature('twoFactor') }, (c) => {
    c.var.session.forget(SETUP)
    return back(c)
  })
  .delete('two-factor.disable', '/two-factor', { authorize: feature('twoFactor'), request: WithPassword }, async (c) => {
    const res = await c.var.auth.api.disableTwoFactor({ body: { password: c.req.valid('json').password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That password is incorrect.'] })
    return withAuthCookies(c, res, back(c).with('status', 'two-factor-disabled'))
  })
  .post('two-factor.recovery-codes', '/two-factor/recovery-codes', { authorize: feature('twoFactor'), request: WithPassword }, async (c) => {
    const res = await c.var.auth.api.generateBackupCodes({ body: { password: c.req.valid('json').password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That password is incorrect.'] })
    const { backupCodes } = (await res.json()) as { backupCodes: string[] }
    return back(c).with({ status: 'recovery-codes-generated', recoveryCodes: backupCodes })
  })
  // Passkeys are added in the browser (resources/components/passkeys.tsx talks to Better Auth's
  // WebAuthn endpoints under /api/auth); this removes one.
  .delete('passkeys.destroy', '/passkeys/:id', { middleware: [mw.passwordConfirmed()], authorize: feature('passkeys') }, async (c) => {
    // Ids are UUIDs (Postgres refuses anything else in the query).
    const id = c.req.param('id')
    if (!z.uuid().safeParse(id).success) throw new NotFoundError()
    const res = await c.var.auth.api.deletePasskey({ body: { id }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new NotFoundError()
    return back(c).with('status', 'passkey-deleted')
  })
  .put('password.update', '/password', { request: Password }, async (c) => {
    const { currentPassword, password } = c.req.valid('json')
    const res = await c.var.auth.api.changePassword({ body: { currentPassword, newPassword: password, revokeOtherSessions: true }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ currentPassword: ['That password is incorrect.'] })
    // Other devices are signed out; this one gets a fresh session.
    return withAuthCookies(c, res, back(c).with('status', 'password-updated'))
  })
  .get('appearance', '/appearance', (c) => c.render('settings/Appearance', {}))

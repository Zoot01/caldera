import { withAuthCookies } from '@caldera/auth'
import { back, defineRequest, defineRoutes, redirect, ValidationError } from '@caldera/http'
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

const headers = (c: { req: { raw: Request } }) => c.req.raw.headers

export const settings = defineRoutes('settings', { prefix: '/settings', middleware: [mw.auth(), mw.verified()] })
  .get('index', '/', (c) => redirect(c, '/settings/profile'))
  .get('profile', '/profile', (c) => c.render('settings/Profile', { mustVerifyEmail: c.var.config.auth.mustVerifyEmail }))
  .patch('profile.update', '/profile', { request: Profile }, async (c) => {
    const { name, email } = c.req.valid('json')
    const user = c.var.user!
    if (name !== user.name) await c.var.auth.api.updateUser({ body: { name }, headers: headers(c) })
    if (email === user.email) return back(c).with('status', 'profile-updated')
    // Better Auth changes an unverified address at once; a verified one only after the new address confirms.
    const res = await c.var.auth.api.changeEmail({ body: { newEmail: email, callbackURL: '/settings/profile' }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ email: ['That email address can’t be used.'] })
    return withAuthCookies(c, res, back(c).with('status', user.emailVerified ? 'email-change-sent' : 'profile-updated'))
  })
  .delete('profile.destroy', '/profile', { request: DeleteAccount }, async (c) => {
    const res = await c.var.auth.api.deleteUser({ body: { password: c.req.valid('json').password }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ password: ['That password is incorrect.'] })
    return withAuthCookies(c, res, redirect(c, '/'))
  })
  .get('security', '/security', (c) => c.render('settings/Security', {}))
  .put('password.update', '/password', { request: Password }, async (c) => {
    const { currentPassword, password } = c.req.valid('json')
    const res = await c.var.auth.api.changePassword({ body: { currentPassword, newPassword: password, revokeOtherSessions: true }, headers: headers(c), asResponse: true })
    if (!res.ok) throw new ValidationError({ currentPassword: ['That password is incorrect.'] })
    // Other devices are signed out; this one gets a fresh session.
    return withAuthCookies(c, res, back(c).with('status', 'password-updated'))
  })
  .get('appearance', '/appearance', (c) => c.render('settings/Appearance', {}))

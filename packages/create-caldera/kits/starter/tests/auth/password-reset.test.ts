import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { ResetPasswordEmail } from '../../src/mail/reset-password.js'
import { createUser } from '../helpers.js'

const t = setupApp(app)

it('emails a reset link, which leads to a new password', async () => {
  const mail = t.fake('mail')
  await createUser(t)
  const client = t.client(http)
  ;(await client.visit('/forgot-password')).assertOk().assertInertia('auth/ForgotPassword')
  ;(await client.post('/forgot-password', { json: { email: 'ann@example.test' } })).assertRedirect()
  mail.assertSent(ResetPasswordEmail, ({ message }) => message.to.some((to) => to.email === 'ann@example.test'))

  // The emailed link goes through Better Auth, which checks it and sends the visitor to the form.
  const link = new URL(mail.sent(ResetPasswordEmail)[0]!.props.url)
  const checked = await client.get(link.pathname + link.search)
  const form = new URL(checked.headers.get('location')!, 'http://localhost')
  expect(form.pathname).toBe('/reset-password')
  const token = form.searchParams.get('token')!
  ;(await client.visit(`/reset-password?token=${token}`)).assertInertia('auth/ResetPassword', { token })

  ;(await client.post('/reset-password', { json: { token, password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertRedirect('/login')
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: 'a-brand-new-password' } })).assertRedirect('/dashboard')
})

it('gives the same answer for unknown addresses, and sends nothing', async () => {
  const mail = t.fake('mail')
  ;(await t.client(http).post('/forgot-password', { json: { email: 'nobody@example.test' } })).assertRedirect()
  mail.assertNothingSent()
})

it('refuses an invalid token', async () => {
  await (await t.client(http).post('/reset-password', { json: { token: 'nope', password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertValidationErrors(['password'])
})

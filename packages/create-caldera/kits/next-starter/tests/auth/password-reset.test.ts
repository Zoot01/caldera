import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { ResetPasswordEmail } from '../../src/mail/reset-password'
import { createUser } from '../helpers'

const t = setupApp(app)

it('emails a reset link, which leads to a new password', async () => {
  const mail = t.fake('mail')
  await createUser(t)
  const client = t.client(http)
  ;(await client.get('/api/forgot-password')).assertOk()
  ;(await client.post('/api/forgot-password', { json: { email: 'ann@example.test' } })).assertRedirect()
  mail.assertSent(ResetPasswordEmail, ({ message }) => message.to.some((to) => to.email === 'ann@example.test'))

  // The emailed link goes through Better Auth, which checks it and sends the visitor to the form.
  const link = new URL(mail.sent(ResetPasswordEmail)[0]!.props.url)
  const checked = await client.get(link.pathname + link.search)
  const form = new URL(checked.headers.get('location')!, 'http://localhost')
  expect(form.pathname).toBe('/reset-password')
  const token = form.searchParams.get('token')!
  ;(await client.get(`/api/reset-password?token=${token}`)).assertJson({ token })

  ;(await client.post('/api/reset-password', { json: { token, password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertRedirect('/login')
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: 'a-brand-new-password' } })).assertRedirect('/dashboard')
})

it('gives the same answer for unknown addresses, and sends nothing', async () => {
  const mail = t.fake('mail')
  ;(await t.client(http).post('/api/forgot-password', { json: { email: 'nobody@example.test' } })).assertRedirect()
  mail.assertNothingSent()
})

it('refuses an invalid token', async () => {
  await (await t.client(http).post('/api/reset-password', { json: { token: 'nope', password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertValidationErrors(['password'])
})

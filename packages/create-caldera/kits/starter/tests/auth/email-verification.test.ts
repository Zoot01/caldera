import { setupApp } from '@caldera-js/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { VerifyEmailEmail } from '../../src/mail/verify-email.js'
import { User } from '../../src/models/user.js'
import { createUser } from '../helpers.js'

const t = setupApp(app)

it('sends a verification link that verifies the address', async () => {
  const mail = t.fake('mail')
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.visit('/verify-email')).assertOk().assertInertia('auth/VerifyEmail')
  ;(await client.post('/email/verification-notification')).assertRedirect()
  const link = new URL(mail.sent(VerifyEmailEmail)[0]!.props.url)
  ;(await client.get(link.pathname + link.search)).assertRedirect('/dashboard')
  expect(await User.findFirst({ where: { email: 'ann@example.test' } })).toMatchObject({ emailVerified: true })
  // Verified: nothing to do here any more.
  ;(await client.get('/verify-email')).assertRedirect('/dashboard')
})

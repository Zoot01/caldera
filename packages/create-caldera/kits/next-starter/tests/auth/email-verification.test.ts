import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { VerifyEmailEmail } from '../../src/mail/verify-email'
import { User } from '../../src/models/user'
import { createUser } from '../helpers'

const t = setupApp(app)

it('sends a verification link that verifies the address', async () => {
  const mail = t.fake('mail')
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.get('/api/verify-email')).assertOk()
  ;(await client.post('/api/email/verification-notification')).assertRedirect()
  const link = new URL(mail.sent(VerifyEmailEmail)[0]!.props.url)
  ;(await client.get(link.pathname + link.search)).assertRedirect('/dashboard')
  expect(await User.findFirst({ where: { email: 'ann@example.test' } })).toMatchObject({ emailVerified: true })
  // Verified: nothing to do here any more.
  ;(await client.get('/api/verify-email')).assertRedirect('/dashboard')
})

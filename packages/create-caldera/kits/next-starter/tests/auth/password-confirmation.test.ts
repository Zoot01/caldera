import { setupApp } from '@caldera/testing'
import { it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { createUser, PASSWORD } from '../helpers'

const t = setupApp(app)

it('renders the confirm password page', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  // No passkey yet: only the password is offered.
  ;(await client.get('/api/confirm-password')).assertOk().assertJson({ passkeys: false })
})

it('confirms the password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.post('/api/confirm-password', { json: { password: PASSWORD } })).assertRedirect('/dashboard')
})

it('refuses a wrong password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  await (await client.post('/api/confirm-password', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
})

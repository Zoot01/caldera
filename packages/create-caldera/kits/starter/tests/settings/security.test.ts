import { setupApp } from '@caldera-js/testing'
import { it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { createUser, PASSWORD } from '../helpers.js'

const t = setupApp(app)

it('renders the security page once the password is confirmed', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.visit('/settings/security')).assertRedirect('/confirm-password')
  ;(await client.post('/confirm-password', { json: { password: PASSWORD } })).assertRedirect('/settings/security')
  ;(await client.visit('/settings/security')).assertOk().assertInertia('settings/Security')
})

it('doesn’t ask again right after signing in with the password', async () => {
  await createUser(t)
  const client = t.client(http)
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/dashboard')
  ;(await client.visit('/settings/security')).assertOk()
})

it('changes the password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.put('/settings/password', { json: { currentPassword: PASSWORD, password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertRedirect()
  await client.post('/logout')
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: 'a-brand-new-password' } })).assertRedirect('/dashboard')
})

it('needs the current password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  await (await client.put('/settings/password', { json: { currentPassword: 'wrong-password', password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertValidationErrors(['currentPassword'])
})

import { setupApp } from '@caldera/testing'
import { it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { createUser, PASSWORD } from '../helpers'

const t = setupApp(app)

it('renders the security page once the password is confirmed', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.get('/api/settings/security')).assertRedirect('/confirm-password?redirect=%2Fsettings%2Fsecurity')
  // The confirm page passes the page on as `redirect`.
  ;(await client.post('/api/confirm-password', { json: { password: PASSWORD, redirect: '/settings/security' } })).assertRedirect('/settings/security')
  ;(await client.get('/api/settings/security')).assertOk()
})

it('doesn’t ask again right after signing in with the password', async () => {
  await createUser(t)
  const client = t.client(http)
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/dashboard')
  ;(await client.get('/api/settings/security')).assertOk()
})

it('changes the password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.put('/api/settings/password', { json: { currentPassword: PASSWORD, password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertRedirect()
  await client.post('/api/logout')
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: 'a-brand-new-password' } })).assertRedirect('/dashboard')
})

it('needs the current password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  await (await client.put('/api/settings/password', { json: { currentPassword: 'wrong-password', password: 'a-brand-new-password', passwordConfirmation: 'a-brand-new-password' } })).assertValidationErrors(['currentPassword'])
})

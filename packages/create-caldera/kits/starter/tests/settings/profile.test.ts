import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { User } from '../../src/models/user.js'
import { createUser, PASSWORD } from '../helpers.js'

const t = setupApp(app)

it('renders the profile page', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.visit('/settings/profile')).assertOk().assertInertia('settings/Profile')
})

it('updates the name and, for an unverified address, the email at once', async () => {
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  ;(await client.patch('/settings/profile', { json: { name: 'Ann Lee', email: 'ann.lee@example.test' } })).assertRedirect()
  expect(await User.find(user.id)).toMatchObject({ name: 'Ann Lee', email: 'ann.lee@example.test', emailVerified: false })
})

it('deletes the account with the right password', async () => {
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  await (await client.delete('/settings/profile', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
  expect(await User.find(user.id)).toBeDefined()
  ;(await client.delete('/settings/profile', { json: { password: PASSWORD } })).assertRedirect('/')
  expect(await User.find(user.id)).toBeUndefined()
  ;(await client.get('/dashboard', { headers: { accept: 'text/html' } })).assertRedirect('/login')
})

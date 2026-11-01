import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { User } from '../../src/models/user'
import { createUser, PASSWORD } from '../helpers'

const t = setupApp(app)

it('renders the profile page', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.get('/api/settings/profile')).assertOk()
})

it('updates the name and, for an unverified address, the email at once', async () => {
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  ;(await client.patch('/api/settings/profile', { json: { name: 'Ann Lee', email: 'ann.lee@example.test' } })).assertRedirect()
  expect(await User.find(user.id)).toMatchObject({ name: 'Ann Lee', email: 'ann.lee@example.test', emailVerified: false })
})

it('never takes someone else’s address, or says whose it is', async () => {
  await createUser(t, { name: 'Bob', email: 'bob@example.test' })
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  // Better Auth answers as if it worked, so the form can't be used to find accounts.
  ;(await client.patch('/api/settings/profile', { json: { name: 'Ann Lee', email: 'bob@example.test' } })).assertRedirect()
  expect(await User.find(user.id)).toMatchObject({ name: 'Ann Lee', email: 'ann@example.test' })
})

it('deletes the account with the right password', async () => {
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  await (await client.delete('/api/settings/profile', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
  expect(await User.find(user.id)).toBeDefined()
  ;(await client.delete('/api/settings/profile', { json: { password: PASSWORD } })).assertRedirect('/')
  expect(await User.find(user.id)).toBeUndefined()
  ;(await client.get('/api/dashboard')).assertUnauthorized()
})

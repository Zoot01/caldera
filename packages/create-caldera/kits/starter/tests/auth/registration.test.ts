import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { User } from '../../src/models/user.js'
import { createUser, PASSWORD } from '../helpers.js'

const t = setupApp(app)

it('renders the registration page', async () => {
  ;(await t.client(http).visit('/register')).assertOk().assertInertia('auth/Register')
})

it('registers people, signed in', async () => {
  const client = t.client(http)
  ;(await client.post('/register', { json: { name: 'Ann', email: 'Ann@Example.test', password: PASSWORD, passwordConfirmation: PASSWORD } })).assertRedirect('/dashboard')
  expect(await User.findFirst({ where: { email: 'ann@example.test' } })).toMatchObject({ name: 'Ann', emailVerified: false })
  ;(await client.visit('/dashboard')).assertOk()
})

it('checks the form', async () => {
  const client = t.client(http)
  await (await client.post('/register', { json: { name: '', email: 'nope', password: 'short', passwordConfirmation: 'other' } })).assertValidationErrors(['name', 'email', 'password', 'passwordConfirmation'])
  await createUser(t)
  await (await client.post('/register', { json: { name: 'Ann', email: 'ann@example.test', password: PASSWORD, passwordConfirmation: PASSWORD } })).assertValidationErrors({ email: /already registered/ })
})

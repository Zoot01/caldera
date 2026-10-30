import { setupApp } from '@caldera/testing'
import { it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { createUser, PASSWORD } from '../helpers.js'

const t = setupApp(app)

it('renders the confirm password page', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.visit('/confirm-password')).assertOk().assertInertia('auth/ConfirmPassword')
})

it('confirms the password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.post('/confirm-password', { json: { password: PASSWORD } })).assertRedirect('/dashboard')
})

it('refuses a wrong password', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  await (await client.post('/confirm-password', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
})

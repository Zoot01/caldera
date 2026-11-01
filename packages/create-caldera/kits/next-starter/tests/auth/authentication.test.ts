import { setupApp } from '@caldera-js/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { createUser, PASSWORD } from '../helpers'

const t = setupApp(app)

it('renders the login page', async () => {
  ;(await t.client(http).get('/api/login')).assertOk()
})

it('signs users in, and takes them to the dashboard', async () => {
  await createUser(t)
  const client = t.client(http)
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/dashboard')
  ;(await client.get('/api/dashboard')).assertOk()
})

it('returns people to the page they were headed to', async () => {
  await createUser(t)
  const client = t.client(http)
  ;(await client.get('/api/settings/security')).assertUnauthorized()
  // The login page passes on where they were going (?redirect=, from the page that sent them).
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD, redirect: '/settings/security' } })).assertRedirect('/settings/security')
  // Only to this site.
  await client.post('/api/logout')
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD, redirect: '//evil.example' } })).assertRedirect('/dashboard')
})

it('refuses a wrong password', async () => {
  await createUser(t)
  const client = t.client(http)
  await (await client.post('/api/login', { json: { email: 'ann@example.test', password: 'wrong-password' } })).assertValidationErrors({ email: /don’t match/ })
  ;(await client.get('/api/dashboard')).assertUnauthorized()
})

it('limits failed attempts', async () => {
  await createUser(t)
  const client = t.client(http)
  for (let i = 0; i < 5; i++) await client.post('/api/login', { json: { email: 'ann@example.test', password: 'wrong-password' } })
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertTooManyRequests()
})

it('signs users out', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.post('/api/logout')).assertRedirect('/')
  ;(await client.get('/api/dashboard')).assertUnauthorized()
})

it('sends signed-in users away from the login and register pages', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.get('/api/login')).assertRedirect('/dashboard')
  expect((await client.get('/api/register')).status).toBe(302)
})

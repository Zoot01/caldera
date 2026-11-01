import { setupApp } from '@caldera-js/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { createUser, PASSWORD } from '../helpers.js'

const t = setupApp(app)

it('renders the login page', async () => {
  ;(await t.client(http).visit('/login')).assertOk().assertInertia('auth/Login')
})

it('signs users in, and takes them to the dashboard', async () => {
  await createUser(t)
  const client = t.client(http)
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/dashboard')
  ;(await client.visit('/dashboard')).assertOk()
})

it('returns people to the page they were headed to', async () => {
  await createUser(t)
  const client = t.client(http)
  ;(await client.get('/settings/security', { headers: { accept: 'text/html' } })).assertRedirect('/login')
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/settings/security')
})

it('refuses a wrong password', async () => {
  await createUser(t)
  const client = t.client(http)
  await (await client.post('/login', { json: { email: 'ann@example.test', password: 'wrong-password' } })).assertValidationErrors({ email: /don’t match/ })
  ;(await client.get('/dashboard', { headers: { accept: 'text/html' } })).assertRedirect('/login')
})

it('limits failed attempts', async () => {
  await createUser(t)
  const client = t.client(http)
  for (let i = 0; i < 5; i++) await client.post('/login', { json: { email: 'ann@example.test', password: 'wrong-password' } })
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertTooManyRequests()
})

it('signs users out', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.post('/logout')).assertRedirect('/')
  ;(await client.get('/dashboard', { headers: { accept: 'text/html' } })).assertRedirect('/login')
})

it('sends signed-in users away from the login and register pages', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.get('/login')).assertRedirect('/dashboard')
  expect((await client.get('/register')).status).toBe(302)
})

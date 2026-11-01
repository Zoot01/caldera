import { setupApp } from '@caldera-js/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { User } from '../../src/models/user'
import { Welcome } from '../../src/notifications/welcome'
import { createUser, PASSWORD } from '../helpers'

const t = setupApp(app)

it('renders the registration page', async () => {
  ;(await t.client(http).get('/api/register')).assertOk()
})

it('registers people, signed in, and welcomes them', async () => {
  const notifications = t.fake('notifications')
  const client = t.client(http)
  ;(await client.post('/api/register', { json: { name: 'Ann', email: 'Ann@Example.test', password: PASSWORD, passwordConfirmation: PASSWORD } })).assertRedirect('/dashboard')
  expect(await User.findFirst({ where: { email: 'ann@example.test' } })).toMatchObject({ name: 'Ann', emailVerified: false })
  ;(await client.get('/api/dashboard')).assertOk()
  const ann = (await User.findFirst({ where: { email: 'ann@example.test' } }))!
  notifications.assertSentTo(ann, Welcome, (p) => p.name === 'Ann' && p.url.endsWith('/dashboard'))
})

it('checks the form', async () => {
  const client = t.client(http)
  await (await client.post('/api/register', { json: { name: '', email: 'nope', password: 'short', passwordConfirmation: 'other' } })).assertValidationErrors(['name', 'email', 'password', 'passwordConfirmation'])
  await createUser(t)
  await (await client.post('/api/register', { json: { name: 'Ann', email: 'ann@example.test', password: PASSWORD, passwordConfirmation: PASSWORD } })).assertValidationErrors({ email: /already registered/ })
})

it('sends people on to the page that asked them to sign up, on this site only', async () => {
  const client = t.client(http)
  const json = { name: 'Ann', email: 'ann@example.test', password: PASSWORD, passwordConfirmation: PASSWORD }
  ;(await client.post('/api/register', { json: { ...json, redirect: '/invitations/abc' } })).assertRedirect('/invitations/abc')
  const other = t.client(http)
  ;(await other.post('/api/register', { json: { ...json, email: 'bob@example.test', redirect: 'https://evil.example' } })).assertRedirect('/dashboard')
})

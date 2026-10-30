import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../src/app.js'
import { http } from '../src/http.js'
import { User } from '../src/models/user.js'

// Boots the app for this file with a fresh database built from drizzle/ (your migrations), and rolls
// every test back. Your dev database is never touched.
const t = setupApp(app)

it('renders the home page', async () => {
  const res = await t.client(http).visit('/')
  res.assertOk().assertInertia('Home', { message: 'Your app is running.', appName: '{{ name }}' })
})

it('lists users from the database', async () => {
  await User.create({ name: 'Ann', email: 'ann@example.test' })
  ;(await t.client(http).get('/users')).assertOk().assertJson({ users: [{ name: 'Ann', email: 'ann@example.test' }] })
})

it('starts every test with an empty database', async () => {
  expect(await User.findMany()).toEqual([])
})

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

it('paints the visitor’s light or dark choice on the first load (the appearance cookie)', async () => {
  const dark = await t.client(http).get('/', { headers: { cookie: 'appearance=dark' } })
  expect(dark.assertOk().text()).toContain('class="dark"')
  ;(await t.client(http).withHeaders({ cookie: 'appearance=dark' }).visit('/')).assertInertia('Home', { appearance: 'dark' })
})

it('shows people an error page, and API clients the JSON error', async () => {
  ;(await t.client(http).visit('/nope')).assertNotFound().assertInertia('Error', { status: 404, message: 'Not found.' })
  ;(await t.client(http).get('/nope', { headers: { accept: 'application/json' } })).assertNotFound().assertJson({ error: { code: 'not_found' } })
})

it('lists users from the database', async () => {
  await User.create({ name: 'Ann', email: 'ann@example.test' })
  ;(await t.client(http).get('/users')).assertOk().assertJson({ users: [{ name: 'Ann', email: 'ann@example.test' }] })
})

it('starts every test with an empty database', async () => {
  expect(await User.findMany()).toEqual([])
})

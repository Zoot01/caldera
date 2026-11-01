import { setupApp } from '@caldera-js/testing'
import { it } from 'vitest'
import { app } from '../src/app.js'
import { http } from '../src/http.js'
import { User } from '../src/models/user.js'

// A fresh database from drizzle/ (your migrations) for this file; each test is rolled back.
const t = setupApp(app)

it('answers the API under /api', async () => {
  ;(await t.client(http).get('/api/hello')).assertOk().assertJson({ message: 'Your app is running.' })
})

it('lists users from the database', async () => {
  await User.create({ name: 'Ann', email: 'ann@example.test' })
  ;(await t.client(http).get('/api/users')).assertJson({ users: [{ name: 'Ann' }] })
})

it('uses the error envelope for unknown API routes', async () => {
  ;(await t.client(http).get('/api/nope')).assertNotFound().assertJson({ error: { code: 'not_found' } })
})

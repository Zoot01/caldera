import { setupApp } from '@caldera-js/testing'
import { it } from 'vitest'
import { app } from '../src/app'
import { http } from '../src/http'

// A fresh database from drizzle/ (your migrations) for this file; each test is rolled back.
const t = setupApp(app)

it('answers the API under /api', async () => {
  ;(await t.client(http).get('/api/hello')).assertOk().assertJson({ message: 'Hello from Caldera.' })
})

it('uses the error envelope for unknown API routes', async () => {
  ;(await t.client(http).get('/api/nope')).assertNotFound().assertJson({ error: { code: 'not_found' } })
})

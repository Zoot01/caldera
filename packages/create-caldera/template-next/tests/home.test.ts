import { expect, it } from 'vitest'
import { http } from '../src/http.js'

const env = { APP_KEY: 'test-key-0123456789-0123456789-0123', DATABASE_URL: ':memory:' }

it('answers the API under /api', async () => {
  const res = await http.request('/api/hello', {}, env)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ message: 'Your app is running.' })
})

it('uses the error envelope for unknown API routes', async () => {
  const res = await http.request('/api/nope', {}, env)
  expect(res.status).toBe(404)
  expect((await res.json()).error.code).toBe('not_found')
})

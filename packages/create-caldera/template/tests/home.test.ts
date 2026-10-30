import { expect, it } from 'vitest'
import { http } from '../src/http.js'

it('responds on the home route', async () => {
  const res = await http.request('/', {}, { APP_KEY: 'test-key-0123456789-0123456789-0123', DATABASE_URL: ':memory:' })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ app: 'ready' })
})

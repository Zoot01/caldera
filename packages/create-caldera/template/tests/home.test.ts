import { expect, it } from 'vitest'
import { http } from '../src/http.js'

const env = { APP_KEY: 'test-key-0123456789-0123456789-0123', DATABASE_URL: ':memory:' }

it('renders the home page', async () => {
  const res = await http.request('/', {}, env)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('"component":"Home"')
})

it('answers Inertia visits with the page as JSON', async () => {
  const res = await http.request('/', { headers: { 'x-inertia': 'true' } }, env)
  expect(await res.json()).toMatchObject({ component: 'Home', props: { message: 'Your app is running.', appName: '{{ name }}' } })
})

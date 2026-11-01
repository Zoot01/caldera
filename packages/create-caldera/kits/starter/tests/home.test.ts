import { setupApp } from '@caldera-js/testing'
import { expect, it } from 'vitest'
import { app } from '../src/app'
import { http } from '../src/http'
import { createUser } from './helpers'

const t = setupApp(app)

it('renders the welcome page for guests and signed-in users', async () => {
  ;(await t.client(http).visit('/')).assertOk().assertInertia('Home', { appName: '{{ name }}', auth: { user: null } })
  const client = await t.client(http).actingAs(await createUser(t))
  ;(await client.visit('/')).assertInertia('Home', (props) => expect(props.auth).toMatchObject({ user: { email: 'ann@example.test' } }))
})

it('paints the visitor’s light or dark choice on the first load (the appearance cookie)', async () => {
  const dark = await t.client(http).get('/', { headers: { cookie: 'appearance=dark' } })
  expect(dark.assertOk().text()).toContain('class="dark"')
})

it('shows people an error page, and API clients the JSON error', async () => {
  ;(await t.client(http).visit('/nope')).assertNotFound().assertInertia('Error', { status: 404, message: 'Not found.' })
  ;(await t.client(http).get('/nope', { headers: { accept: 'application/json' } })).assertNotFound().assertJson({ error: { code: 'not_found' } })
})

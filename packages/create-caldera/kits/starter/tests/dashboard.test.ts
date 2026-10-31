import { setupApp } from '@caldera/testing'
import { it } from 'vitest'
import { app } from '../src/app.js'
import { http } from '../src/http.js'
import { createUser } from './helpers.js'

const t = setupApp(app)

it('sends guests to the login page', async () => {
  ;(await t.client(http).get('/dashboard', { headers: { accept: 'text/html' } })).assertRedirect('/login')
})

it('shows signed-in users their dashboard', async () => {
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  ;(await client.visit('/dashboard')).assertOk().assertInertia('Dashboard')
})

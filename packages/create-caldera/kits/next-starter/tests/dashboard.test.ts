import { setupApp } from '@caldera-js/testing'
import { it } from 'vitest'
import { app } from '../src/app'
import { http } from '../src/http'
import { createUser } from './helpers'

const t = setupApp(app)

it('sends guests to the login page', async () => {
  ;(await t.client(http).get('/api/dashboard')).assertUnauthorized()
})

it('shows signed-in users their dashboard', async () => {
  const user = await createUser(t)
  const client = await t.client(http).actingAs(user)
  ;(await client.get('/api/dashboard')).assertOk()
})

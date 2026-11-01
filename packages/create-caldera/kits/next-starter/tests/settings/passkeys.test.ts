import { defaultDatabase } from '@caldera/db'
import { setupApp } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { passkey } from '../../src/db/schema'
import { actingAsConfirmed, createUser } from '../helpers'

const t = setupApp(app)

// Adding a passkey and signing in with one need a browser's authenticator (WebAuthn); the browser
// tests cover those. Here: the settings page and removing one.

it('lists the person’s passkeys on the security page', async () => {
  const client = await actingAsConfirmed(t, await createUser(t))
  ;(await client.get('/api/settings/security')).assertJsonPath('passkeys', [])
})

it('offers passkey sign-in on the login page', async () => {
  ;(await t.client(http).get('/api/login')).assertJson({ passkeys: true })
})

it('can’t remove a passkey that isn’t theirs', async () => {
  const bob = await createUser(t, { name: 'Bob', email: 'bob@example.test' })
  const id = crypto.randomUUID()
  // Stored as a registration would (its key material is never read here).
  await defaultDatabase().current().insert(passkey).values({ id, name: 'Bob’s phone', publicKey: 'key', userId: bob.id, credentialID: 'cred', counter: 0, deviceType: 'singleDevice', backedUp: false, createdAt: new Date() })
  const client = await actingAsConfirmed(t, await createUser(t))
  ;(await client.delete(`/api/settings/passkeys/${id}`)).assertNotFound()
  ;(await client.delete('/api/settings/passkeys/not-an-id')).assertNotFound()
  expect(await defaultDatabase().current().select().from(passkey)).toHaveLength(1)
})

it('starts registration only for signed-in people who confirmed their password recently', async () => {
  const guest = await t.client(http).get('/api/auth/passkey/generate-register-options')
  expect(guest.status).toBe(401)
  const unconfirmed = await t.client(http).actingAs(await createUser(t, { email: 'bob@example.test' }))
  expect((await unconfirmed.get('/api/auth/passkey/generate-register-options')).status).toBe(403)
  const client = await actingAsConfirmed(t, await createUser(t))
  const options = await client.get('/api/auth/passkey/generate-register-options')
  expect(options.status).toBe(200)
  expect(JSON.parse(options.text())).toMatchObject({ rp: { id: 'localhost' }, user: { name: 'ann@example.test' } })
})

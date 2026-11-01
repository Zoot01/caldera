import { setupApp, type TestClient } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { User } from '../../src/models/user'
import { actingAsConfirmed, createUser, PASSWORD, totp } from '../helpers'

const t = setupApp(app)

/** Turns two-factor on as a person would: password, scan (the key), first code. Returns the key and recovery codes. */
async function turnOn(client: TestClient) {
  ;(await client.post('/api/settings/two-factor', { json: { password: PASSWORD } })).assertRedirect()
  const { setup } = (await client.get('/api/settings/security')).json<{ twoFactor: { setup: { qr: string; key: string } } }>().twoFactor
  expect(setup.qr).toContain('<svg')
  ;(await client.post('/api/settings/two-factor/confirm', { json: { code: totp(setup.key) } })).assertRedirect()
  // Flashed once, right after they're made: the next look at the page shows them.
  const page = await client.get('/api/settings/security')
  return { key: setup.key, recoveryCodes: page.json<{ recoveryCodes: string[] }>().recoveryCodes }
}

it('turns on only after a right code from the app, and shows the recovery codes once', async () => {
  const user = await createUser(t)
  const client = await actingAsConfirmed(t, user)
  await (await client.post('/api/settings/two-factor', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
  ;(await client.post('/api/settings/two-factor', { json: { password: PASSWORD } })).assertRedirect()
  await (await client.post('/api/settings/two-factor/confirm', { json: { code: '000000' } })).assertValidationErrors(['code'])
  expect(await User.find(user.id)).toMatchObject({ twoFactorEnabled: false })

  await client.delete('/api/settings/two-factor/setup')
  const { recoveryCodes } = await turnOn(client)
  expect(recoveryCodes).toHaveLength(10)
  expect(await User.find(user.id)).toMatchObject({ twoFactorEnabled: true })
  ;(await client.get('/api/settings/security')).assertJsonPath('twoFactor', { enabled: true, setup: null })
})

it('asks for a code after the password, then signs in', async () => {
  const client = await actingAsConfirmed(t, await createUser(t))
  const { key } = await turnOn(client)
  await client.post('/api/logout')

  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/two-factor-challenge')
  ;(await client.get('/api/dashboard')).assertUnauthorized()
  ;(await client.get('/api/two-factor-challenge')).assertOk()
  await (await client.post('/api/two-factor-challenge', { json: { code: '000000' } })).assertValidationErrors(['code'])
  // The next period's code: the one used to turn it on was just spent.
  ;(await client.post('/api/two-factor-challenge', { json: { code: totp(key, Date.now() + 30_000) } })).assertRedirect('/dashboard')
  ;(await client.get('/api/dashboard')).assertOk()
})

it('takes a recovery code instead, once', async () => {
  const client = await actingAsConfirmed(t, await createUser(t))
  const { recoveryCodes } = await turnOn(client)
  await client.post('/api/logout')
  await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })
  ;(await client.post('/api/two-factor-challenge', { json: { recoveryCode: recoveryCodes[0] } })).assertRedirect('/dashboard')

  await client.post('/api/logout')
  await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })
  await (await client.post('/api/two-factor-challenge', { json: { recoveryCode: recoveryCodes[0] } })).assertValidationErrors(['recoveryCode'])
})

it('sends people without a pending sign-in back to the login page', async () => {
  ;(await t.client(http).get('/api/two-factor-challenge')).assertRedirect('/login')
})

it('turns off with the password', async () => {
  const user = await createUser(t)
  const client = await actingAsConfirmed(t, user)
  await turnOn(client)
  await (await client.delete('/api/settings/two-factor', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
  ;(await client.delete('/api/settings/two-factor', { json: { password: PASSWORD } })).assertRedirect()
  expect(await User.find(user.id)).toMatchObject({ twoFactorEnabled: false })
  await client.post('/api/logout')
  ;(await client.post('/api/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/dashboard')
})

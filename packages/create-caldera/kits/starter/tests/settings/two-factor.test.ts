import { setupApp, type TestClient } from '@caldera-js/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { User } from '../../src/models/user.js'
import { actingAsConfirmed, createUser, PASSWORD, totp } from '../helpers.js'

const t = setupApp(app)

/** Turns two-factor on as a person would: password, scan (the key), first code. Returns the key and recovery codes. */
async function turnOn(client: TestClient) {
  ;(await client.post('/settings/two-factor', { json: { password: PASSWORD } })).assertRedirect()
  const { setup } = (await client.visit('/settings/security')).page().props.twoFactor as { setup: { qr: string; key: string } }
  expect(setup.qr).toContain('<svg')
  ;(await client.post('/settings/two-factor/confirm', { json: { code: totp(setup.key) } })).assertRedirect()
  const page = (await client.visit('/settings/security')).page()
  return { key: setup.key, recoveryCodes: page.flash?.recoveryCodes as string[] }
}

it('turns on only after a right code from the app, and shows the recovery codes once', async () => {
  const user = await createUser(t)
  const client = await actingAsConfirmed(t, user)
  await (await client.post('/settings/two-factor', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
  ;(await client.post('/settings/two-factor', { json: { password: PASSWORD } })).assertRedirect()
  await (await client.post('/settings/two-factor/confirm', { json: { code: '000000' } })).assertValidationErrors(['code'])
  expect(await User.find(user.id)).toMatchObject({ twoFactorEnabled: false })

  await client.delete('/settings/two-factor/setup')
  const { recoveryCodes } = await turnOn(client)
  expect(recoveryCodes).toHaveLength(10)
  expect(await User.find(user.id)).toMatchObject({ twoFactorEnabled: true })
  ;(await client.visit('/settings/security')).assertInertia('settings/Security', (props) => expect(props.twoFactor).toEqual({ enabled: true, setup: null }))
})

it('asks for a code after the password, then signs in', async () => {
  const client = await actingAsConfirmed(t, await createUser(t))
  const { key } = await turnOn(client)
  await client.post('/logout')

  ;(await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/two-factor-challenge')
  ;(await client.get('/dashboard', { headers: { accept: 'text/html' } })).assertRedirect('/login')
  ;(await client.visit('/two-factor-challenge')).assertOk().assertInertia('auth/TwoFactorChallenge')
  await (await client.post('/two-factor-challenge', { json: { code: '000000' } })).assertValidationErrors(['code'])
  // The next period's code: the one used to turn it on was just spent.
  ;(await client.post('/two-factor-challenge', { json: { code: totp(key, Date.now() + 30_000) } })).assertRedirect('/dashboard')
  ;(await client.visit('/dashboard')).assertOk()
})

it('takes a recovery code instead, once', async () => {
  const client = await actingAsConfirmed(t, await createUser(t))
  const { recoveryCodes } = await turnOn(client)
  await client.post('/logout')
  await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })
  ;(await client.post('/two-factor-challenge', { json: { recoveryCode: recoveryCodes[0] } })).assertRedirect('/dashboard')

  await client.post('/logout')
  await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })
  await (await client.post('/two-factor-challenge', { json: { recoveryCode: recoveryCodes[0] } })).assertValidationErrors(['recoveryCode'])
})

it('sends people without a pending sign-in back to the login page', async () => {
  ;(await t.client(http).get('/two-factor-challenge')).assertRedirect('/login')
})

it('turns off with the password', async () => {
  const user = await createUser(t)
  const client = await actingAsConfirmed(t, user)
  await turnOn(client)
  await (await client.delete('/settings/two-factor', { json: { password: 'wrong-password' } })).assertValidationErrors(['password'])
  ;(await client.delete('/settings/two-factor', { json: { password: PASSWORD } })).assertRedirect()
  expect(await User.find(user.id)).toMatchObject({ twoFactorEnabled: false })
  await client.post('/logout')
  ;(await client.post('/login', { json: { email: 'ann@example.test', password: PASSWORD } })).assertRedirect('/dashboard')
})

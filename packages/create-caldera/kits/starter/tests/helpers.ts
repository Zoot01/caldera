import type { TestApp } from '@caldera/testing'
import { http } from '../src/http.js'
import { User } from '../src/models/user.js'

export const PASSWORD = 'correct-horse-battery'
// In a file of its own so the browser tests can use it without loading the app.
export { totp } from './totp.js'

/** A user with a password, made through Better Auth (as registering does). */
export async function createUser(t: TestApp<any>, attributes: { name?: string; email?: string; password?: string } = {}) {
  const input = { name: 'Ann', email: 'ann@example.test', password: PASSWORD, ...attributes }
  await t.services.auth.api.signUpEmail({ body: input })
  return (await User.findFirst({ where: { email: input.email } }))!
}

/**
 * Signed in as `user` with the password just confirmed, as after signing in with it: what pages
 * behind `mw.passwordConfirmed()` (Security) need.
 */
export async function actingAsConfirmed(t: TestApp<any>, user: { id: string }) {
  const client = await t.client(http).actingAs(user as never)
  ;(await client.post('/confirm-password', { json: { password: PASSWORD } })).assertRedirect()
  return client
}

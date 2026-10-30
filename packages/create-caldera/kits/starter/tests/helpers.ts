import type { TestApp } from '@caldera/testing'
import { User } from '../src/models/user.js'

export const PASSWORD = 'correct-horse-battery'

/** A user with a password, made through Better Auth (as registering does). */
export async function createUser(t: TestApp<any>, attributes: { name?: string; email?: string; password?: string } = {}) {
  const input = { name: 'Ann', email: 'ann@example.test', password: PASSWORD, ...attributes }
  await t.services.auth.api.signUpEmail({ body: input })
  return (await User.findFirst({ where: { email: input.email } }))!
}

import { makeSignature } from 'better-auth/crypto'

interface AuthContextLike {
  secret: string
  authCookies: { sessionToken: { name: string } }
  internalAdapter: {
    findUserById(id: string): Promise<unknown>
    createSession(userId: string, dontRememberMe?: boolean, override?: Record<string, unknown>, overrideAll?: boolean): Promise<{ token: string }>
  }
}

/**
 * A real Better Auth session for `user`, as the cookie a browser would send after signing in: what
 * `client.actingAs(user)` in @caldera/testing uses. Through Better Auth's own session store and
 * signing, so `authenticate()` (and anything else reading the session) sees a signed-in user.
 * For tests only: it skips the password.
 */
export async function sessionCookieFor(auth: { $context: Promise<unknown> }, user: { id: string | number }): Promise<{ name: string; value: string }> {
  const ctx = (await auth.$context) as AuthContextLike
  const id = String(user.id)
  if (!(await ctx.internalAdapter.findUserById(id))) throw new Error(`actingAs(): no user with id ${id} (create it in the test database first).`)
  const session = await ctx.internalAdapter.createSession(id, false, {}, true)
  return { name: ctx.authCookies.sessionToken.name, value: `${session.token}.${await makeSignature(session.token, ctx.secret)}` }
}

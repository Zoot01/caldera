import { CalderaError, defineProvider, type RegisteredConfig, type RegisteredEnv } from '@caldera/core'
import { defaultDatabase } from '@caldera/db'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { AuthUser } from './policy.js'

/**
 * The parts of a Better Auth instance Caldera uses. Structural, so this package doesn't
 * import better-auth at runtime: the app owns that dependency and its version.
 */
export interface BetterAuthLike {
  handler(request: Request): Promise<Response>
  api: {
    getSession(options: { headers: Headers }): Promise<{ user: { id: string }; session: { id: string; expiresAt: Date } } | null>
  }
}

export interface AuthSession {
  id: string
  userId: string
  expiresAt: Date
}

export interface BetterAuthProviderOptions<A extends BetterAuthLike> {
  /**
   * Builds the Better Auth instance, once, on first use. `db` is the app's Drizzle client, for
   * `drizzleAdapter(db, { provider, schema: { users, session, account, verification } })`.
   */
  create: (ctx: { db: unknown; env: RegisteredEnv; config: RegisteredConfig }) => A
  /**
   * Loads `c.var.user` through this model (usually `User`), so hidden columns stay hidden and
   * the type is the app's own row type. Defaults to Better Auth's user object.
   */
  userModel?: { find(id: string): Promise<unknown> }
}

/**
 * Registers `auth` (the Better Auth instance) and declares the request-scoped `user` and
 * `authSession` (null until `authenticate()` runs on a route), so `c.var.user` is typed.
 */
export function betterAuthProvider<A extends BetterAuthLike>(options: BetterAuthProviderOptions<A>) {
  return defineProvider({
    name: 'auth',
    register: (app) => ({
      auth: app.singleton(() => options.create({ db: defaultDatabase().client, env: app.env, config: app.config })),
      authUserModel: options.userModel ?? null,
    }),
    request: {
      user: (): AuthUser | null => null,
      authSession: (): AuthSession | null => null,
    },
  })
}

interface AuthVars {
  auth: BetterAuthLike
  authUserModel: { find(id: string): Promise<unknown> } | null
}

/**
 * Resolves the session from the request's cookie and sets `c.var.user` and `c.var.authSession`.
 * With `required: true` (the default), requests without a valid session get a 401.
 * Register it in your middleware registry: `defineMiddleware({ auth: authenticate })`, so it runs
 * at the `auth` priority, before binding and authorization.
 */
export function authenticate(options: { required?: boolean } = {}): MiddlewareHandler {
  const required = options.required ?? true
  return async (c, next) => {
    const vars = c.var as unknown as AuthVars
    if (!vars.auth) throw new Error('authenticate() needs betterAuthProvider() in the app.')
    const result = await vars.auth.api.getSession({ headers: c.req.raw.headers })
    // A session whose user was deleted (or soft-deleted) since sign-in counts as no session.
    const user = result ? (vars.authUserModel ? await vars.authUserModel.find(result.user.id) : result.user) : null
    if (result && user) {
      c.set('user' as never, user as never)
      c.set('authSession' as never, { id: result.session.id, userId: result.user.id, expiresAt: result.session.expiresAt } as never)
    } else if (required) {
      throw new CalderaError('unauthenticated', 'You need to sign in to do that.')
    }
    await next()
  }
}

/** Mounts Better Auth's endpoints (sign-up, sign-in, OAuth callbacks…) under `basePath`. */
export function authRoutes(basePath = '/api/auth'): Hono {
  return new Hono().on(['GET', 'POST'], `${basePath.replace(/\/$/, '')}/*`, (c: Context) => (c.var as unknown as AuthVars).auth.handler(c.req.raw))
}

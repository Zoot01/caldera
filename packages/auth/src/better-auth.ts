import { BootError, CalderaError, defineProvider, type ProviderDefinition, type RegisteredConfig, type RegisteredEnv, type Singleton } from '@caldera/core'
import { defaultDatabase, type Database } from '@caldera/db'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { AuthUser } from './policy.js'

/**
 * The parts of a Better Auth instance Caldera uses. Structural, so this package doesn't
 * import better-auth at runtime: the app owns that dependency and its version.
 */
export interface BetterAuthLike {
  handler(request: Request): Promise<Response>
  // `object`, not `{ trustedOrigins?: unknown }`: an all-optional type trips TypeScript's weak-type check.
  options?: object
  api: {
    getSession(options: { headers: Headers }): Promise<{ user: { id: string }; session: { id: string; expiresAt: Date; activeOrganizationId?: string | null } } | null>
  }
}

export interface AuthSession {
  id: string
  userId: string
  expiresAt: Date
  /** Set when Better Auth's organization plugin is enabled. */
  activeOrganizationId?: string | null
}

export interface BetterAuthProviderOptions<A extends BetterAuthLike> {
  /**
   * Builds the Better Auth instance, once, on first use. `db` is the app's Drizzle client, for
   * `drizzleAdapter(db, { provider, schema: { users, session, account, verification } })`.
   */
  create: (ctx: { db: unknown; env: RegisteredEnv; config: RegisteredConfig; trustedOrigins: string[] }) => A
  /**
   * The same list you pass to `originCheck()` from `@caldera/http`. Hand it to Better Auth as
   * `trustedOrigins: ctx.trustedOrigins`; Caldera refuses to start if the two disagree, so one
   * layer can never block requests the other allows.
   */
  trustedOrigins?: readonly string[]
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
// The return type is written out so declaration files keep `AuthUser` as a reference: inferred, it
// would be resolved to `{ id: string }` at build time, before the app's AuthRegister exists.
export function betterAuthProvider<A extends BetterAuthLike>(
  options: BetterAuthProviderOptions<A>,
): ProviderDefinition<'auth', { auth: Singleton<A>; authUserModel: { find(id: string): Promise<unknown> } | null }, { user: AuthUser | null; authSession: AuthSession | null }> {
  return defineProvider({
    name: 'auth',
    register: (app) => ({
      auth: app.singleton(() => {
        const trustedOrigins = [...(options.trustedOrigins ?? [])]
        const auth = options.create({ db: joiningClient(defaultDatabase()), env: app.env, config: app.config, trustedOrigins })
        if (options.trustedOrigins) assertSameOrigins(trustedOrigins, (auth.options as { trustedOrigins?: unknown } | undefined)?.trustedOrigins)
        return auth
      }),
      authUserModel: options.userModel ?? null,
    }),
    request: {
      user: (): AuthUser | null => null,
      authSession: (): AuthSession | null => null,
    },
  })
}

/**
 * The Drizzle client Better Auth gets: every call goes to the transaction open in this async context
 * (`db.current()`), else the root client. Better Auth's writes so join a transaction the app opened
 * (signing someone up while creating their team commits or rolls back as one), and a test's
 * transaction, instead of racing it on another connection ("database is locked" on SQLite) and
 * surviving its rollback.
 */
function joiningClient(database: Database): unknown {
  return new Proxy(database.client as object, {
    get(_root, property) {
      const current = database.current() as object
      const value = Reflect.get(current, property, current) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value
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
      const authSession: AuthSession = { id: result.session.id, userId: result.user.id, expiresAt: result.session.expiresAt }
      if (result.session.activeOrganizationId !== undefined) authSession.activeOrganizationId = result.session.activeOrganizationId
      c.set('authSession' as never, authSession as never)
    } else if (required) {
      throw new CalderaError('unauthenticated', 'You need to sign in to do that.')
    }
    await next()
  }
}

/**
 * Mounts Better Auth's endpoints (sign-up, sign-in, OAuth callbacks…) under `basePath`. With
 * Caldera's app session (`startSession()` from `@caldera/http`), signing in regenerates it and
 * signing out clears it, so flash data and remembered pages don't carry across users.
 */
export function authRoutes(basePath = '/api/auth'): Hono {
  return new Hono().on(['GET', 'POST'], `${basePath.replace(/\/$/, '')}/*`, async (c: Context) => {
    const response = await (c.var as unknown as AuthVars).auth.handler(c.req.raw)
    syncAppSession(c, response)
    return response
  })
}

/**
 * For routes that call Better Auth themselves (`auth.api.signInEmail({ body, headers, asResponse: true })`)
 * and answer with their own response, usually a redirect: copies Better Auth's cookies (the session
 * token) onto `to`, and keeps the app session in step as `authRoutes()` does. Returns `to`.
 *
 * ```ts
 * const res = await c.var.auth.api.signInEmail({ body: { email, password }, headers: c.req.raw.headers, asResponse: true })
 * if (!res.ok) throw new ValidationError({ email: ['These credentials do not match our records.'] })
 * return withAuthCookies(c, res, intended(c, '/dashboard'))
 * ```
 */
export function withAuthCookies<R extends Response>(c: Context, from: Response, to: R): R {
  for (const cookie of from.headers.getSetCookie()) to.headers.append('set-cookie', cookie)
  syncAppSession(c, from)
  return to
}

interface AppSession {
  regenerate(): void
  invalidate(): void
}

/**
 * Reads the outcome from Better Auth's own session cookie, so every way of signing in (password,
 * OAuth callbacks, magic links, plugins) is covered without hooking each endpoint.
 */
function syncAppSession(c: Context, response: Response) {
  const token = response.headers.getSetCookie().find((cookie) => /^(?:__Secure-|__Host-)?[^=]*session_token=/.test(cookie))
  if (!token) return
  const value = token.slice(token.indexOf('=') + 1).split(';')[0]
  const cleared = value === '' || /;\s*max-age=0/i.test(token)
  try {
    const session = (c.var as { session?: AppSession }).session
    if (cleared) session?.invalidate()
    else session?.regenerate()
  } catch (error) {
    // No app session in this app (startSession() isn't installed): nothing to keep in step.
    if (!(error instanceof CalderaError && error.code === 'session_not_started')) throw error
  }
}

function assertSameOrigins(expected: string[], actual: unknown) {
  const normalize = (list: readonly string[]) => [...new Set(list.map((o) => new URL(o).origin))].sort()
  const given = Array.isArray(actual) ? normalize(actual as string[]) : undefined
  if (!given || given.join() !== normalize(expected).join()) {
    throw new BootError(
      'trusted_origins_mismatch',
      `Better Auth's trustedOrigins (${given?.join(', ') ?? 'not set'}) differ from Caldera's (${normalize(expected).join(', ')}). Pass \`trustedOrigins: ctx.trustedOrigins\` to betterAuth().`,
    )
  }
}

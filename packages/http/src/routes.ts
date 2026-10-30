import type { RegisteredHonoEnv } from '@caldera/core'
import { Hono, type Context, type Env, type MiddlewareHandler } from 'hono'
import type { HandlerResponse, MergePath, ParamKeys, Schema, ToSchema, TypedResponse } from 'hono/types'
import { bindingMiddleware, describeBindings, type BindEnv, type Bindings } from './bind.js'
import { ForbiddenError } from './errors.js'
import { DEFAULT_PRIORITY, sortByPriority, type NamedMiddleware } from './middleware.js'
import { requestJsonSchemas, requestMiddleware, type AnyRequest, type InputOf } from './request.js'

// Mirrors Hono's internal MergeTypedResponse, which it doesn't export.
type MergeTypedResponse<T> =
  T extends Promise<void> ? T : T extends Promise<infer T2> ? (T2 extends TypedResponse ? T2 : TypedResponse) : T extends TypedResponse ? T : TypedResponse

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

export interface RouteOptions<R extends AnyRequest | undefined, B extends Bindings = {}> {
  request?: R
  /** Route model binding: `{ post: Post }` loads `:post` into a typed `c.var.post`, or 404s. */
  bind?: B
  /**
   * Runs after binding: return `false` (or throw) to deny. With `@caldera/auth`,
   * `authorize: allows(Post, 'update', 'post')` checks the bound row against its policy.
   */
  authorize?: (c: Context) => unknown
  middleware?: NamedMiddleware[]
  description?: string
}

/** One route as data: what `caldera route:list --json`, the MCP server and AGENTS.md read. */
export interface RouteRecord {
  name: string
  method: Uppercase<Method>
  path: string
  params: string[]
  middleware: { name: string; options: unknown }[]
  input: Record<string, unknown>
  /** Bound parameters and what loads them (model name, or `custom`). */
  bindings?: Record<string, string>
  /** The ability that guards the route (from `allows()`), or `custom` for any other check. */
  authorize?: { ability: string; param: string | null } | 'custom'
  description?: string
  source?: { file: string; line: number }
}

interface GroupOptions<Prefix extends string> {
  prefix?: Prefix
  middleware?: NamedMiddleware[]
}

type RouteMethod<M extends Method, G extends string, E extends Env, S extends Schema, Prefix extends string, Names> = {
  <const N extends string, P extends string, Res extends HandlerResponse<any>, Req extends AnyRequest | undefined = undefined, B extends Bindings = {}>(
    name: N,
    path: P,
    options: RouteOptions<Req, B>,
    handler: (c: Context<E & BindEnv<B>, MergePath<Prefix, P>, InputOf<Req>>) => Res,
  ): RouteGroup<G, E, S & ToSchema<M, MergePath<Prefix, P>, InputOf<Req>, MergeTypedResponse<Res>>, Prefix, Names & { [K in `${G}.${N}`]: MergePath<Prefix, P> }>
  <const N extends string, P extends string, Res extends HandlerResponse<any>>(
    name: N,
    path: P,
    handler: (c: Context<E, MergePath<Prefix, P>, {}>) => Res,
  ): RouteGroup<G, E, S & ToSchema<M, MergePath<Prefix, P>, {}, MergeTypedResponse<Res>>, Prefix, Names & { [K in `${G}.${N}`]: MergePath<Prefix, P> }>
}

/**
 * A named group of routes backed by a real Hono app. Chain the methods: each call returns
 * the group with a wider type, which is what keeps `hc` clients and `url()` typed.
 */
export interface RouteGroup<G extends string, E extends Env, S extends Schema, Prefix extends string, Names> {
  readonly kind: 'caldera.routes'
  readonly name: G
  /** The underlying Hono app. Mount it with `app.route('/', group.app)` or use `createRouter`. */
  readonly app: Hono<E, S>
  readonly routes: readonly RouteRecord[]
  /** Phantom: route name → path pattern. Only used for typing `url()`. */
  readonly names: Names
  get: RouteMethod<'get', G, E, S, Prefix, Names>
  post: RouteMethod<'post', G, E, S, Prefix, Names>
  put: RouteMethod<'put', G, E, S, Prefix, Names>
  patch: RouteMethod<'patch', G, E, S, Prefix, Names>
  delete: RouteMethod<'delete', G, E, S, Prefix, Names>
}

export type AnyRouteGroup = RouteGroup<string, any, any, string, any>

/**
 * Starts a route group. `name` prefixes every route name (`posts` → `posts.show`).
 * Handlers see your app's services on `c.var` once `caldera generate` has registered the app.
 * `E` comes last on purpose: passing it explicitly would stop `G` and `Prefix` being inferred.
 */
export function defineRoutes<const G extends string, const Prefix extends string = '/', E extends Env = RegisteredHonoEnv & Env>(
  name: G,
  options: GroupOptions<Prefix> = {},
): RouteGroup<G, E, {}, Prefix, {}> {
  const app = new Hono<E>()
  const routes: RouteRecord[] = []
  const prefix = options.prefix ?? '/'
  const groupMiddleware = options.middleware ?? []
  const seen = new Set<string>()

  const add =
    (method: Method) =>
    (routeName: string, path: string, optionsOrHandler: RouteOptions<AnyRequest | undefined, Bindings> | Function, maybeHandler?: Function) => {
      const routeOptions = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler
      const handler = (typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler) as (c: Context) => unknown
      const fullName = `${name}.${routeName}`
      if (seen.has(fullName)) throw new Error(`Route name "${fullName}" is defined twice.`)
      seen.add(fullName)

      const fullPath = joinPath(prefix, path)
      const named: { name: string; options: unknown; handler: MiddlewareHandler }[] = [
        ...groupMiddleware,
        ...(routeOptions.middleware ?? []),
        ...(routeOptions.bind ? [{ name: 'bind', options: undefined, handler: bindingMiddleware(routeOptions.bind, fullPath) }] : []),
        ...(routeOptions.authorize ? [{ name: 'authorize', options: undefined, handler: authorizeMiddleware(routeOptions.authorize) }] : []),
        ...(routeOptions.request ? requestMiddleware(routeOptions.request).map((m) => ({ ...m, options: undefined })) : []),
      ]
      const priority = [...groupMiddleware, ...(routeOptions.middleware ?? [])][0]?.priority ?? DEFAULT_PRIORITY
      const ordered = sortByPriority(named, priority)

      const on = app.on as unknown as (method: string, path: string, ...handlers: MiddlewareHandler[]) => unknown
      on.call(app, method.toUpperCase(), fullPath, ...ordered.map((m) => m.handler), async (c) => handler(c) as Response)
      routes.push({
        name: fullName,
        method: method.toUpperCase() as Uppercase<Method>,
        path: fullPath,
        params: paramNames(fullPath),
        middleware: ordered.filter((m) => m.name !== 'validate').map((m) => ({ name: m.name, options: m.options ?? null })),
        input: routeOptions.request ? requestJsonSchemas(routeOptions.request) : {},
        ...(routeOptions.bind ? { bindings: describeBindings(routeOptions.bind) } : {}),
        ...(routeOptions.authorize ? { authorize: describeAuthorize(routeOptions.authorize) } : {}),
        ...(routeOptions.description ? { description: routeOptions.description } : {}),
        ...callerSource(),
      })
      return group
    }

  const group = {
    kind: 'caldera.routes',
    name,
    app,
    routes,
    names: {},
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
  }
  return group as unknown as RouteGroup<G, E, {}, Prefix, {}>
}

function describeAuthorize(check: Function): RouteRecord['authorize'] {
  const tagged = check as { ability?: unknown; param?: unknown }
  return typeof tagged.ability === 'string' ? { ability: tagged.ability, param: typeof tagged.param === 'string' ? tagged.param : null } : 'custom'
}

function authorizeMiddleware(check: (c: Context) => unknown): MiddlewareHandler {
  return async (c, next) => {
    if ((await check(c)) === false) throw new ForbiddenError()
    await next()
  }
}

export function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

export function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!)
}

export type { ParamKeys }

// Records where a route was defined so agents can jump to it. Skips this file's own frames.
function callerSource(): { source?: { file: string; line: number } } {
  const stack = new Error().stack?.split('\n') ?? []
  for (const frame of stack.slice(1)) {
    const match = frame.match(/\(?((?:file:\/\/)?[^\s()]+?):(\d+):\d+\)?\s*$/)
    if (!match) continue
    const file = match[1]!.replace(/^file:\/\//, '')
    if (file.includes('/@caldera/http/') || file.includes('/packages/http/src/') || file.includes('/packages/http/dist/')) continue
    if (file.startsWith('node:') || file.includes('/node_modules/')) continue
    return { source: { file, line: Number(match[2]) } }
  }
  return {}
}

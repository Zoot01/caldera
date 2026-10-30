import { Hono, type Context, type Env, type MiddlewareHandler } from 'hono'
import type { HandlerResponse, MergePath, ParamKeys, Schema, ToSchema, TypedResponse } from 'hono/types'
import { DEFAULT_PRIORITY, sortByPriority, type NamedMiddleware } from './middleware.js'
import { requestJsonSchemas, requestMiddleware, type AnyRequest, type InputOf } from './request.js'

// Mirrors Hono's internal MergeTypedResponse, which it doesn't export.
type MergeTypedResponse<T> =
  T extends Promise<void> ? T : T extends Promise<infer T2> ? (T2 extends TypedResponse ? T2 : TypedResponse) : T extends TypedResponse ? T : TypedResponse

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

export interface RouteOptions<R extends AnyRequest | undefined> {
  request?: R
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
  description?: string
  source?: { file: string; line: number }
}

interface GroupOptions<Prefix extends string> {
  prefix?: Prefix
  middleware?: NamedMiddleware[]
}

type RouteMethod<M extends Method, G extends string, E extends Env, S extends Schema, Prefix extends string, Names> = {
  <const N extends string, P extends string, Res extends HandlerResponse<any>, Req extends AnyRequest | undefined = undefined>(
    name: N,
    path: P,
    options: RouteOptions<Req>,
    handler: (c: Context<E, MergePath<Prefix, P>, InputOf<Req>>) => Res,
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
 * Starts a route group. `name` prefixes every route name (`posts` → `posts.show`), and
 * `E` is your app's Hono env, usually `HonoEnvOf<typeof app>` from `@caldera/core`.
 */
export function defineRoutes<E extends Env = Env, const G extends string = string, const Prefix extends string = '/'>(
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
    (routeName: string, path: string, optionsOrHandler: RouteOptions<AnyRequest | undefined> | Function, maybeHandler?: Function) => {
      const routeOptions = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler
      const handler = (typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler) as (c: Context) => unknown
      const fullName = `${name}.${routeName}`
      if (seen.has(fullName)) throw new Error(`Route name "${fullName}" is defined twice.`)
      seen.add(fullName)

      const fullPath = joinPath(prefix, path)
      const named: { name: string; options: unknown; handler: MiddlewareHandler }[] = [
        ...groupMiddleware,
        ...(routeOptions.middleware ?? []),
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

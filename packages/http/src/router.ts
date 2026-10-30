import { Hono, type Env } from 'hono'
import type { ParamKeys, Schema } from 'hono/types'
import type { UnionToIntersection } from '@caldera/core'
import type { AnyRouteGroup, RouteRecord } from './routes.js'

type SchemaOf<G> = G extends { app: Hono<any, infer S> } ? S : never
type EnvOf<Groups extends readonly AnyRouteGroup[]> = Groups[number] extends { app: Hono<infer E, any> } ? E : Env
type NamesOf<G> = G extends { names: infer N } ? N : never

export type RouteNames<Groups extends readonly AnyRouteGroup[]> = UnionToIntersection<NamesOf<Groups[number]>>

// Narrowed with `infer … extends` rather than `& Schema`: intersecting with Schema's index
// signature would make every client path `possibly undefined`.
type MergedSchema<Groups extends readonly AnyRouteGroup[]> =
  UnionToIntersection<SchemaOf<Groups[number]>> extends infer S extends Schema ? S : never

type Params<Path> = [ParamKeys<Path>] extends [never]
  ? [params?: Record<string, never>, query?: QueryValues]
  : [params: { [K in ParamKeys<Path> as K extends `${infer Name}?` ? Name : K]: string | number }, query?: QueryValues]

type QueryValues = Record<string, string | number | boolean | null | undefined | (string | number | boolean)[]>

export interface Router<E extends Env, S extends Schema, Names> {
  /** One Hono app with every group mounted. `hc<typeof router.app>` gives a typed client. */
  readonly app: Hono<E, S>
  /** Typed URL builder: unknown names and missing params are compile errors. Works client-side too. */
  url<N extends keyof Names & string>(name: N, ...args: Params<Names[N]>): string
  /** Every route as data, for `caldera route:list --json`, MCP and AGENTS.md. */
  manifest(): { schemaVersion: 1; routes: RouteRecord[] }
}

/** Combines route groups. Throws if two groups define the same route name. */
export function createRouter<const Groups extends readonly AnyRouteGroup[]>(
  ...groups: Groups
): Router<EnvOf<Groups>, MergedSchema<Groups>, RouteNames<Groups>> {
  const app = new Hono()
  const patterns = new Map<string, string>()
  for (const group of groups) {
    for (const route of group.routes) {
      if (patterns.has(route.name)) throw new Error(`Route name "${route.name}" is defined in more than one group.`)
      patterns.set(route.name, route.path)
    }
    app.route('/', group.app)
  }

  return {
    app: app as never,
    url(name, ...[params, query]: [Record<string, unknown>?, QueryValues?]) {
      const pattern = patterns.get(name)
      if (pattern === undefined) throw new Error(`Unknown route name "${name}".`)
      return buildUrl(pattern, params ?? {}, query)
    },
    manifest() {
      return { schemaVersion: 1, routes: groups.flatMap((g) => g.routes) }
    },
  }
}

export function buildUrl(pattern: string, params: Record<string, unknown>, query?: QueryValues): string {
  const path = pattern.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?(\?)?/g, (_, key: string, _regex, optional) => {
    const value = params[key]
    if (value === undefined || value === null) {
      if (optional) return ''
      throw new Error(`Missing route parameter "${key}" for "${pattern}".`)
    }
    return encodeURIComponent(String(value))
  })
  const cleaned = path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
  if (!query) return cleaned
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item))
  }
  const qs = search.toString()
  return qs ? `${cleaned}?${qs}` : cleaned
}

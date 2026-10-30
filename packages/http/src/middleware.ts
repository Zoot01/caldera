import type { MiddlewareHandler } from 'hono'

/**
 * Laravel's middleware priority: whatever order a route lists its middleware in, these
 * run in this order relative to each other. `authorize` and `validate` come from
 * `defineRequest`; `bind` is reserved for route model binding.
 */
export const DEFAULT_PRIORITY = ['session', 'auth', 'throttle', 'bind', 'authorize', 'validate'] as const

export interface NamedMiddleware {
  readonly kind: 'caldera.middleware'
  readonly name: string
  readonly options: unknown
  readonly handler: MiddlewareHandler
  readonly priority: readonly string[]
}

type Factories = Record<string, (...args: any[]) => MiddlewareHandler>

export type MiddlewareRegistry<D extends Factories> = {
  readonly [K in keyof D]: (...args: Parameters<D[K]>) => NamedMiddleware
}

/**
 * A typed registry of named middleware: `mw.auth({ guard: 'session' })` instead of strings.
 * Names appear in the route manifest, and `priority` fixes their relative order.
 */
export function defineMiddleware<const D extends Factories>(
  factories: D,
  options: { priority?: readonly (Extract<keyof D, string> | (typeof DEFAULT_PRIORITY)[number])[] } = {},
): MiddlewareRegistry<D> {
  const priority: readonly string[] = options.priority ?? DEFAULT_PRIORITY
  const registry: Record<string, (...args: unknown[]) => NamedMiddleware> = {}
  for (const [name, factory] of Object.entries(factories)) {
    registry[name] = (...args) => ({ kind: 'caldera.middleware', name, options: args[0], handler: factory(...args), priority })
  }
  return registry as MiddlewareRegistry<D>
}

/**
 * Orders middleware like Laravel's `SortedMiddleware`: entries named in the priority list
 * are sorted among the positions they already occupy; everything else stays where it is.
 */
export function sortByPriority<T extends { name: string }>(items: readonly T[], priority: readonly string[]): T[] {
  const rank = (item: T) => priority.indexOf(item.name)
  const slots = items.map((item, index) => (rank(item) >= 0 ? index : -1)).filter((index) => index >= 0)
  const prioritized = slots.map((index) => items[index]!).sort((a, b) => rank(a) - rank(b))
  const result = [...items]
  slots.forEach((slot, i) => {
    result[slot] = prioritized[i]!
  })
  return result
}

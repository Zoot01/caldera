import { CalderaError } from '@caldera-js/core'
import type { AuthUser, Gate } from '@caldera-js/auth'
import type { Context } from 'hono'
import type { z } from 'zod'

export type ChannelType = 'public' | 'private' | 'presence'

/** `posts.{postId}` → `'postId'`. */
export type ParamNames<P extends string> = P extends `${string}{${infer N}}${infer R}` ? N | ParamNames<R> : never
export type ChannelParams<P extends string> = [ParamNames<P>] extends [never] ? Record<string, never> : { [K in ParamNames<P>]: string | number }

/** Loads a row for a channel parameter: a Caldera model (`findByRouteKey`) or a function, as route model binding. */
export type ChannelBinder = { readonly name?: string; findByRouteKey(value: string): Promise<unknown> } | ((value: string) => Promise<unknown>)
type Bound<B> = B extends (...args: any[]) => Promise<infer T> ? NonNullable<T> : B extends { findByRouteKey(value: string): Promise<infer T> } ? NonNullable<T> : never

export type AuthorizeContext<P extends string, B> = {
  /** The signed-in user (`c.var.user`); `null` only on channels with `guests: true`. */
  readonly user: AuthUser
  /** The channel name's parameters, as strings. */
  readonly params: { readonly [K in ParamNames<P>]: string }
  /** The request's gate (`c.var.gate`), for policies: `gate.can(Post, 'view', post)`. */
  readonly gate: Gate
  /** The auth request, when there is one (not for `caldera mcp`'s checks). */
  readonly c: Context | undefined
} & { readonly [K in keyof B]: Bound<B[K]> }

/** What a presence channel shows other members about someone. `id` defaults to the user's id. */
export type MemberInfo = { id?: string | number } & Record<string, unknown>

export interface ChannelOptions<P extends string, T extends ChannelType, B, M extends MemberInfo, CE> {
  /** `private` (the default) and `presence` channels need authorization; `public` ones anyone can join. */
  type?: T
  /** Route model binding for the parameters: `{ post: Post }` loads `ctx.post`; a missing row denies. */
  bind?: B
  /** Who may join (private and presence). Return true to allow. */
  authorize?: T extends 'public' ? never : (ctx: AuthorizeContext<P, B>) => boolean | Promise<boolean>
  /** Presence channels: what other members see about this user (no secrets: every member gets it). */
  member?: T extends 'presence' ? (ctx: AuthorizeContext<P, B>) => M | Promise<M> : never
  /** Messages clients send each other directly (whispers), checked by the receiving client. Private and presence only. */
  clientEvents?: T extends 'public' ? never : CE
  /** Let signed-out visitors join (private and presence). Off by default. */
  guests?: boolean
}

export interface ChannelDefinition<P extends string = string, T extends ChannelType = ChannelType, B = any, M extends MemberInfo = MemberInfo, CE = {}> {
  readonly kind: 'caldera.channel'
  readonly pattern: P
  readonly type: T
  readonly options: ChannelOptions<P, T, B, M, CE>
  /** The name clients subscribe to: `private-posts.42`. */
  name(params: ChannelParams<P>): string
  /** A target for a broadcast event's `on`: `PostChannel.with({ postId })`. */
  with(params: ChannelParams<P>): ChannelRef<P>
  /** The parameters, if `name` (a subscription's name, prefix included) is this channel; otherwise null. */
  match(name: string): Record<string, string> | null
  /** Where it's defined, for `caldera broadcast:list`. */
  readonly source: { file: string; line: number } | undefined
}
export type AnyChannel = ChannelDefinition<string, ChannelType, any, any, any>

/** One channel to broadcast on, from `Channel.with(params)`. */
export interface ChannelRef<P extends string = string> {
  readonly kind: 'caldera.channel-ref'
  readonly pattern: P
  /** The wire name, prefix included. */
  readonly name: string
}

const PREFIX: Record<ChannelType, string> = { public: '', private: 'private-', presence: 'presence-' }
// Pusher's channel-name alphabet, without `.`: dots separate a pattern's parts, so a value can't contain one.
const PARAM_VALUE = /^[A-Za-z0-9_\-=@,;]+$/
const PATTERN = /^[A-Za-z0-9_\-=@,.;{}]+$/

/**
 * A realtime channel: `defineChannel('posts.{postId}', { bind: { post: Post }, authorize: ({ gate, post }) => gate.can(Post, 'view', post) })`.
 * Private by default. Export it from a file in `src/channels`; `caldera generate` registers it.
 */
export function defineChannel<const P extends string, const T extends ChannelType = 'private', const B extends Record<string, ChannelBinder> = {}, M extends MemberInfo = MemberInfo, const CE extends Record<string, z.ZodType> = {}>(
  pattern: P,
  options: ChannelOptions<P, T, B, M, CE> = {},
): ChannelDefinition<P, T, B, M, CE> {
  const type = (options.type ?? 'private') as T
  if (!PATTERN.test(pattern) || /^(private|presence|private-encrypted)-/.test(pattern)) {
    throw new CalderaError('channel_pattern_invalid', `Channel "${pattern}": use letters, digits and _-=@,.; with {params}, without a private-/presence- prefix (set \`type\` instead).`)
  }
  const params = [...pattern.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!)
  if (pattern.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').match(/[{}]/)) throw new CalderaError('channel_pattern_invalid', `Channel "${pattern}": a parameter is written {name}.`)
  for (const param of Object.keys(options.bind ?? {})) {
    if (!params.includes(param)) throw new CalderaError('channel_bind_unknown', `Channel "${pattern}" binds "${param}", but has no {${param}}.`)
  }
  if (type !== 'public' && !options.authorize) {
    throw new CalderaError('channel_authorize_missing', `Channel "${pattern}" is ${type}, so it needs \`authorize\` (or make it \`type: 'public'\`).`)
  }
  if (type === 'public' && (options.authorize || options.clientEvents)) {
    throw new CalderaError('channel_public_options', `Channel "${pattern}" is public: anyone can join it, so it takes no \`authorize\` or \`clientEvents\`.`)
  }
  if (type !== 'presence' && options.member) throw new CalderaError('channel_member_not_presence', `Channel "${pattern}" has \`member\`, which only presence channels use.`)

  const prefix = PREFIX[type]
  const regex = new RegExp(`^${escape(prefix)}${pattern.split(/\{[A-Za-z_][A-Za-z0-9_]*\}/).map(escape).join('([A-Za-z0-9_\\-=@,;]+)')}$`)
  const name = (values: Record<string, string | number>) => {
    let out = pattern as string
    for (const param of params) {
      const value = values[param]
      if (value === undefined) throw new CalderaError('channel_param_missing', `Channel "${pattern}" needs {${param}}.`)
      const text = String(value)
      if (!PARAM_VALUE.test(text)) throw new CalderaError('channel_param_invalid', `Channel "${pattern}": {${param}} is "${text}", which a channel name can't contain (letters, digits and _-=@,; only).`)
      out = out.replace(`{${param}}`, text)
    }
    const full = prefix + out
    if (full.length > 164) throw new CalderaError('channel_name_too_long', `Channel name "${full}" is over 164 characters.`)
    return full
  }
  return {
    kind: 'caldera.channel',
    pattern,
    type,
    options,
    name: name as never,
    with: (values) => ({ kind: 'caldera.channel-ref', pattern, name: name(values as Record<string, string>) }),
    match(candidate) {
      const found = regex.exec(candidate)
      return found ? Object.fromEntries(params.map((param, i) => [param, found[i + 1]!])) : null
    },
    source: callSite(),
  }
}

export function isChannel(value: unknown): value is AnyChannel {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'caldera.channel'
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function callSite(): { file: string; line: number } | undefined {
  for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
    const match = frame.match(/\(?((?:file:\/\/)?[^\s()]+?):(\d+):\d+\)?\s*$/)
    if (!match) continue
    // Loaders (tsx) give modules URLs with a query and percent-encoding: keep just the path.
    const file = decodeURIComponent(match[1]!.replace(/^file:\/\//, '').replace(/\?.*$/, ''))
    if (file.includes('/packages/broadcast/src/') || file.includes('/packages/broadcast/dist/') || file.includes('/@caldera-js/broadcast/') || file.startsWith('node:') || file.includes('/node_modules/')) continue
    return { file, line: Number(match[2]) }
  }
  return undefined
}

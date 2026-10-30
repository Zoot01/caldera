// The browser side, framework-free: one pusher-js connection, shared subscriptions, socket ids for
// toOthers. No server code: channel types come from `.caldera/broadcast.client.gen.ts`.
import PusherModule from 'pusher-js'
import type { Channel, PresenceChannel } from 'pusher-js'
import type { ClientConfig } from './driver.js'

// pusher-js is CommonJS whose types describe its ES build: the default import is the class at runtime.
const Pusher = PusherModule as unknown as typeof import('pusher-js').default
type PusherClient = InstanceType<typeof Pusher>

export type ChannelTypes = Record<string, 'public' | 'private' | 'presence'>

/** What `useChannel`/`subscribe` get from the server: the driver's client config. */
export type BroadcastClientConfig = ClientConfig & {
  /** Where pusher-js asks to join private and presence channels. */
  authEndpoint?: string
}

const STATE = Symbol.for('caldera.broadcast.client')
interface ClientState {
  types: ChannelTypes
  config: BroadcastClientConfig | null | undefined
  pusher?: PusherClient
  subscriptions: Map<string, { channel: Channel; count: number }>
  /** Bumped by each configureBroadcast(), so subscribers made before it join again. */
  version: number
  listeners: Set<() => void>
}
// On globalThis: the generated module and the app may load separate copies of this file (Vite pre-bundling).
const state = (): ClientState => ((globalThis as { [STATE]?: ClientState })[STATE] ??= { types: {}, config: undefined, subscriptions: new Map(), version: 0, listeners: new Set() })

/** Called by `.caldera/broadcast.client.gen.ts`: every channel pattern and its type. */
export function registerChannels(types: ChannelTypes) {
  Object.assign(state().types, types)
}

/**
 * Connection options from the server (`c.var.broadcast.client()`, shared as the `broadcast` page
 * prop). `null` (the log and null drivers) means there's no realtime server: subscriptions do nothing.
 */
export function configureBroadcast(config: BroadcastClientConfig | null | undefined) {
  const current = state()
  if (JSON.stringify(config) === JSON.stringify(current.config)) return
  current.pusher?.disconnect()
  current.pusher = undefined
  current.subscriptions.clear()
  current.config = config
  current.version++
  for (const listener of current.listeners) listener()
}

/**
 * Calls `listener` whenever the connection options change (the first configureBroadcast() often
 * comes after components mounted: Inertia's first `navigate` follows the first render). Returns a stop function.
 */
export function onConfigured(listener: () => void): () => void {
  state().listeners.add(listener)
  return () => void state().listeners.delete(listener)
}

/** Changes on every configureBroadcast(), for useSyncExternalStore. */
export function configVersion(): number {
  return state().version
}

/** The shared pusher-js connection, opened on first use; undefined without a realtime server. */
export function connection(): PusherClient | undefined {
  const current = state()
  if (!current.config) return undefined
  if (!current.pusher) {
    const { authEndpoint, ...options } = current.config
    current.pusher = new Pusher(options.key, {
      ...options,
      cluster: options.cluster ?? '',
      channelAuthorization: { endpoint: authEndpoint ?? '/_caldera/broadcast/auth', transport: 'ajax' },
    })
  }
  return current.pusher
}

/** This browser's connection id, for `X-Socket-ID` (so `toOthers` skips it). */
export function socketId(): string | undefined {
  return state().pusher?.connection.socket_id
}

/**
 * Adds `X-Socket-ID` to a request config, so the server's `emit(…, { toOthers: true })` skips this
 * browser. For Inertia: `http.onRequest(withSocketId)` (from @inertiajs/core).
 */
export function withSocketId<T extends { headers?: Record<string, unknown> }>(config: T): T {
  const id = socketId()
  return id ? { ...config, headers: { ...config.headers, 'X-Socket-ID': id } } : config
}

/** A channel's subscription name: `posts.{post}` with `{ post: 42 }` → `private-posts.42`. */
export function channelName(pattern: string, params: Record<string, string | number> = {}): string {
  const type = state().types[pattern]
  if (!type) throw new Error(`No channel "${pattern}" in src/channels (run \`caldera generate\`, and import .caldera/broadcast.client.gen in resources/app.tsx).`)
  const name = pattern.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, param: string) => {
    const value = params[param]
    if (value === undefined) throw new Error(`Channel "${pattern}" needs {${param}}.`)
    return String(value)
  })
  return type === 'public' ? name : `${type}-${name}`
}

export interface Subscription {
  readonly name: string
  readonly channel: Channel
  /** Calls `handler` for each `event`; returns a function that stops. */
  listen(event: string, handler: (data: unknown, meta: { user_id?: string }) => void): () => void
  /** Sends a client event to everyone else on the channel (private and presence channels). */
  whisper(event: string, data: unknown): boolean
  /** Drops this use of the channel; the last one unsubscribes. */
  leave(): void
}

/**
 * Joins a channel (once per page, however many components use it). Undefined without a realtime
 * server. Private and presence channels are authorized by the app (`/_caldera/broadcast/auth`).
 */
export function subscribe(pattern: string, params: Record<string, string | number> = {}): Subscription | undefined {
  const pusher = connection()
  if (!pusher) return undefined
  const name = channelName(pattern, params)
  const current = state()
  let entry = current.subscriptions.get(name)
  if (!entry) current.subscriptions.set(name, (entry = { channel: pusher.subscribe(name), count: 0 }))
  entry.count++
  const shared = entry
  let left = false
  return {
    name,
    channel: shared.channel,
    listen(event, handler) {
      const callback = (data: unknown, meta?: { user_id?: string }) => handler(data, meta ?? {})
      shared.channel.bind(event, callback)
      return () => void shared.channel.unbind(event, callback)
    },
    whisper: (event, data) => shared.channel.trigger(`client-${event}`, data),
    leave() {
      if (left) return
      left = true
      if (--shared.count > 0) return
      current.subscriptions.delete(name)
      pusher.unsubscribe(name)
    },
  }
}

export interface Member<Info = unknown> {
  id: string
  info: Info
}

/** A presence channel's members right now. */
export function membersOf<Info>(subscription: Subscription | undefined): Member<Info>[] {
  const members: Member<Info>[] = []
  ;(subscription?.channel as PresenceChannel | undefined)?.members?.each((member: { id: string; info: Info }) => void members.push({ id: member.id, info: member.info }))
  return members
}

// The browser side, framework-free: one connection (pusher-js, or the sse driver's event stream),
// shared subscriptions, socket ids for toOthers. No server code: channel types come from
// `.caldera/broadcast.client.gen.ts`.
import PusherModule from 'pusher-js'
import type { Channel, PresenceChannel } from 'pusher-js'
import type { PusherClientConfig, SseClientConfig } from './driver.js'

// pusher-js is CommonJS whose types describe its ES build: the default import is the class at runtime.
const Pusher = PusherModule as unknown as typeof import('pusher-js').default
type PusherClient = InstanceType<typeof Pusher>

export type ChannelTypes = Record<string, 'public' | 'private' | 'presence'>

/** What `useChannel`/`subscribe` get from the server: the driver's client config. */
export type BroadcastClientConfig =
  | (PusherClientConfig & {
      /** Where pusher-js asks to join private and presence channels. */
      authEndpoint?: string
    })
  | SseClientConfig

type Handler = (data: unknown, meta: { user_id?: string }) => void

/** One joined channel, whichever transport carries it. */
interface Joined {
  readonly subscribed: boolean
  bind(event: string, handler: Handler): void
  unbind(event: string, handler: Handler): void
  trigger(event: string, data: unknown): boolean
  members(): { id: string; info: unknown }[]
}

interface Transport {
  socketId(): string | undefined
  join(name: string): Joined
  leave(name: string): void
  disconnect(): void
}

const STATE = Symbol.for('caldera.broadcast.client')
interface ClientState {
  types: ChannelTypes
  config: BroadcastClientConfig | null | undefined
  transport?: Transport
  subscriptions: Map<string, { joined: Joined; count: number }>
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
  current.transport?.disconnect()
  current.transport = undefined
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

function transport(): Transport | undefined {
  const current = state()
  if (!current.config) return undefined
  current.transport ??= current.config.transport === 'sse' ? sseTransport(current.config.url) : pusherTransport(current.config)
  return current.transport
}

/** The shared pusher-js client (the pusher protocol only), opened on first use. */
export function connection(): PusherClient | undefined {
  return (transport() as { pusher?: PusherClient } | undefined)?.pusher
}

/** This browser's connection id, for `X-Socket-ID` (so `toOthers` skips it). */
export function socketId(): string | undefined {
  return state().transport?.socketId()
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
  /** True once the server accepted it. */
  readonly subscribed: boolean
  /** Calls `handler` for each `event`; returns a function that stops. `pusher:subscription_succeeded` and `pusher:subscription_error` report joining. */
  listen(event: string, handler: Handler): () => void
  /** Sends a client event to everyone else on the channel (private and presence channels, pusher protocol). */
  whisper(event: string, data: unknown): boolean
  /** Presence channels: everyone on it now. */
  members<Info = unknown>(): Member<Info>[]
  /** Drops this use of the channel; the last one unsubscribes. */
  leave(): void
}

/**
 * Joins a channel (once per page, however many components use it). Undefined without a realtime
 * server. Private and presence channels are authorized by the app.
 */
export function subscribe(pattern: string, params: Record<string, string | number> = {}): Subscription | undefined {
  const connected = transport()
  if (!connected) return undefined
  const name = channelName(pattern, params)
  const current = state()
  let entry = current.subscriptions.get(name)
  if (!entry) current.subscriptions.set(name, (entry = { joined: connected.join(name), count: 0 }))
  entry.count++
  const shared = entry
  let left = false
  return {
    name,
    get subscribed() {
      return shared.joined.subscribed
    },
    listen(event, handler) {
      shared.joined.bind(event, handler)
      return () => shared.joined.unbind(event, handler)
    },
    whisper: (event, data) => shared.joined.trigger(`client-${event}`, data),
    members: <Info>() => shared.joined.members() as Member<Info>[],
    leave() {
      if (left) return
      left = true
      if (--shared.count > 0) return
      current.subscriptions.delete(name)
      connected.leave(name)
    },
  }
}

export interface Member<Info = unknown> {
  id: string
  info: Info
}

/** A presence channel's members right now. */
export function membersOf<Info>(subscription: Subscription | undefined): Member<Info>[] {
  return subscription?.members<Info>() ?? []
}

function pusherTransport(config: PusherClientConfig & { authEndpoint?: string }): Transport & { pusher: PusherClient } {
  const { authEndpoint, transport: _transport, ...options } = config
  const pusher = new Pusher(options.key, { ...options, cluster: options.cluster ?? '', channelAuthorization: { endpoint: authEndpoint ?? '/_caldera/broadcast/auth', transport: 'ajax' } })
  // pusher-js passes (data, metadata); each handler is wrapped once, so unbind finds it.
  const wrapped = new WeakMap<Handler, (data: unknown, meta?: { user_id?: string }) => void>()
  const wrap = (handler: Handler) => {
    let fn = wrapped.get(handler)
    if (!fn) wrapped.set(handler, (fn = (data, meta) => handler(data, meta ?? {})))
    return fn
  }
  return {
    pusher,
    socketId: () => pusher.connection.socket_id,
    join(name) {
      const channel: Channel = pusher.subscribe(name)
      return {
        get subscribed() {
          return channel.subscribed
        },
        bind: (event, handler) => void channel.bind(event, wrap(handler)),
        unbind: (event, handler) => void channel.unbind(event, wrap(handler)),
        trigger: (event, data) => channel.trigger(event, data),
        members() {
          const found: { id: string; info: unknown }[] = []
          ;(channel as PresenceChannel).members?.each((member: { id: string; info: unknown }) => void found.push({ id: member.id, info: member.info }))
          return found
        },
      }
    },
    leave: (name) => pusher.unsubscribe(name),
    disconnect: () => pusher.disconnect(),
  }
}

/**
 * The sse driver: one `text/event-stream` from the app, read with fetch (the same in every browser,
 * and in Node), reconnecting after a drop and joining every channel again on the new stream.
 */
function sseTransport(url: string): Transport {
  interface SseChannel extends Joined {
    subscribed: boolean
    handlers: Map<string, Set<Handler>>
    emit(event: string, data: unknown): void
  }
  const channels = new Map<string, SseChannel>()
  let streamId: string | undefined
  let stopped = false
  const controller = new AbortController()
  const base = typeof location === 'undefined' ? url : new URL(url, location.href).href

  const post = (path: string, body: object) =>
    fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
  const joinOnServer = async (name: string, channel: SseChannel) => {
    if (!streamId) return
    const response = await post('join', { stream: streamId, channel: name }).catch(() => undefined)
    if (response?.ok) {
      channel.subscribed = true
      channel.emit('pusher:subscription_succeeded', {})
    } else {
      channel.emit('pusher:subscription_error', { type: 'AuthError', status: response?.status ?? 0 })
    }
  }

  const read = async () => {
    while (!stopped) {
      try {
        const response = await fetch(base, { headers: { accept: 'text/event-stream' }, credentials: 'same-origin', signal: controller.signal })
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n')
            if (!data) continue
            const parsed = JSON.parse(data) as { id?: string; channel?: string; event?: string; data?: string }
            if (event === 'connected') {
              streamId = parsed.id
              for (const [name, channel] of channels) void joinOnServer(name, channel)
            } else if (parsed.channel && parsed.event) {
              channels.get(parsed.channel)?.emit(parsed.event, JSON.parse(parsed.data ?? 'null'))
            }
          }
        }
      } catch {
        if (stopped) return
      }
      // Dropped: a new stream, every channel joined again.
      streamId = undefined
      for (const channel of channels.values()) channel.subscribed = false
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  void read()

  return {
    socketId: () => streamId,
    join(name) {
      const channel: SseChannel = {
        subscribed: false,
        handlers: new Map(),
        emit(event, data) {
          for (const handler of channel.handlers.get(event) ?? []) handler(data, {})
        },
        bind(event, handler) {
          channel.handlers.set(event, (channel.handlers.get(event) ?? new Set()).add(handler))
        },
        unbind(event, handler) {
          channel.handlers.get(event)?.delete(handler)
        },
        trigger: () => false,
        members: () => [],
      }
      channels.set(name, channel)
      void joinOnServer(name, channel)
      return channel
    },
    leave(name) {
      channels.delete(name)
      if (streamId) void post('leave', { stream: streamId, channel: name }).catch(() => {})
    },
    disconnect() {
      stopped = true
      controller.abort()
    },
  }
}

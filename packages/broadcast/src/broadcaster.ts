import { BootError, CalderaError, createManager, defineProvider, type DriverDefinition, type Manager, type RegisterContext, type RegisteredServices } from '@caldera-js/core'
import type { AnyEvent, BroadcastPayload, EventDefinition, EventPayload } from '@caldera-js/events'
import type { Context } from 'hono'
import { z } from 'zod'
import { isChannel, type AnyChannel, type ChannelParams, type ChannelRef } from './channel.js'
import { logDriver, nullDriver, type BroadcastCapabilities, type BroadcastDriver, type BroadcastMessage, type ClientConfig } from './driver.js'
import { pusherDriver } from './pusher.js'
import { sseDriver } from './sse.js'

/**
 * Filled by `caldera generate` (register.d.ts), for typed hooks in the browser: channels by pattern
 * and broadcast events by the name browsers receive.
 * `declare module '@caldera-js/broadcast' { interface BroadcastRegister { channels: { 'posts.{post}': typeof PostChannel }; events: { 'post.updated': typeof PostUpdated } } }`
 */
export interface BroadcastRegister {}

export interface BroadcastConfig<N extends string = string> {
  default: NoInfer<N>
  connections: { [K in N]?: ({ driver: string } & Record<string, unknown>) | undefined }
}

/** A model's broadcast events (`defineModel(…, { broadcast })`) as events, for BroadcastRegister. */
export type ModelBroadcastEvent<M> = M extends { readonly '~broadcast': infer W } ? EventDefinition<z.ZodType, W> : never

/** One broadcast, as `fake()` records it. */
export interface SentBroadcast {
  event: string
  channels: string[]
  data: unknown
  socketId: string | undefined
}

export interface BroadcastFake {
  sent(): SentBroadcast[]
  /** An event was broadcast (on `channel`, when given), optionally matching its data. */
  assertBroadcast<E extends AnyEvent>(event: E, match?: { on?: ChannelRef | string; data?: (data: BroadcastPayload<E>) => boolean }): void
  assertNotBroadcast<E extends AnyEvent>(event: E): void
  assertNothingBroadcast(): void
  restore(): void
}

/** Why a subscription was allowed or refused: the auth route's answer, and `caldera mcp`'s trace. */
export type AuthorizeResult =
  | { allowed: true; channel: string; pattern: string; type: 'private' | 'presence'; member?: { user_id: string; user_info: Record<string, unknown> } }
  | { allowed: false; status: 401 | 403; reason: 'no_channel' | 'public' | 'guest' | 'not_found' | 'denied'; message: string; pattern?: string }

export interface AuthorizeRequest {
  /** The subscription's name, prefix included: `private-posts.42`. */
  channel: string
  user: { id: string | number } | null
  /** The request's gate, for policies (`c.var.gate`). */
  gate?: unknown
  c?: Context
}

export interface Broadcaster<N extends string = string> {
  readonly manager: Manager<BroadcastDriver, BroadcastCapabilities, N>
  readonly channels: readonly AnyChannel[]
  register(...channels: AnyChannel[]): void
  /** The channel definition a subscription name belongs to, with its parameters. */
  find(name: string): { channel: AnyChannel; params: Record<string, string> } | undefined
  /** Sends an event now and waits for the server to accept it. `on` takes `Channel.with(...)` or names. */
  send(on: ChannelRef | string | readonly (ChannelRef | string)[], event: string, data: unknown, options?: { except?: string; connection?: N }): Promise<void>
  /**
   * A broadcast event's broadcast (what `emit` calls): after the database transaction commits, without
   * holding up the response (`waitUntil` on edge), or as a queued job with `queue: true`.
   */
  broadcast<E extends AnyEvent>(event: E, payload: EventPayload<E>, options?: { toOthers?: boolean }): Promise<void>
  /**
   * Checks a broadcast now (channels, payload size) and returns the function that sends it, for code
   * that sends after a commit: model broadcasting prepares inside the write and sends once it commits.
   */
  prepare(on: ChannelRef | string | readonly (ChannelRef | string)[], event: string, data: unknown, options?: { toOthers?: boolean }): () => void
  /** Runs a channel's authorization: who may subscribe, and a presence member's info. */
  authorize(request: AuthorizeRequest): Promise<AuthorizeResult>
  /** Signs an allowed subscription for the pusher protocol. */
  sign(socketId: string, result: Extract<AuthorizeResult, { allowed: true }>): Promise<{ auth: string; channel_data?: string }>
  /** The browser's connection options (no secrets), or undefined when there's nothing to connect to. */
  client(connection?: N): ClientConfig | undefined
  /** Waits for broadcasts still being sent (tests, scripts, shutdown). */
  flush(): Promise<void>
  /** Records broadcasts instead of sending them. */
  fake(): BroadcastFake
  /** The built-in job `queue: true` broadcasts run as. */
  readonly job: unknown
  services: RegisteredServices
}

export const BROADCAST_JOB = 'caldera.broadcast'
const SOCKET_ID = /^\d+\.\d+$/
const jobPayload = z.object({ event: z.string(), channels: z.array(z.string()), data: z.string(), socketId: z.string().optional(), connection: z.string().optional() })

interface QueueLike {
  dispatch(job: unknown, payload: unknown): Promise<unknown>
  register(...jobs: unknown[]): void
}

const fromGlobal = <T>(key: string) => (globalThis as { [key: symbol]: unknown })[Symbol.for(key)] as T | undefined

export function createBroadcaster<const N extends string>(
  config: BroadcastConfig<N>,
  options: {
    channels?: readonly AnyChannel[]
    drivers?: readonly DriverDefinition<BroadcastDriver, BroadcastCapabilities>[]
    queue?: () => QueueLike | undefined
    /** The request being handled, for `toOthers` and `waitUntil`. */
    current?: () => Context | undefined
  } = {},
): Broadcaster<N> {
  const manager = createManager<BroadcastDriver, BroadcastCapabilities, N>({
    kind: 'broadcast',
    drivers: [pusherDriver, sseDriver, logDriver, nullDriver, ...(options.drivers ?? [])] as DriverDefinition<BroadcastDriver, BroadcastCapabilities>[],
    config: { default: config.default, instances: config.connections as never },
    hints: { 'durable-object': "It's in @caldera-js/broadcast/cloudflare: pass `drivers: [durableObjectDriver]` to broadcastProvider." },
  })
  const channels: AnyChannel[] = []
  const pending = new Set<Promise<unknown>>()
  let fake: { sent: SentBroadcast[] } | undefined

  const register = (channel: AnyChannel) => {
    if (!isChannel(channel)) throw new CalderaError('channel_invalid', 'register() takes channels from defineChannel().')
    if (channels.includes(channel)) return
    const clash = channels.find((other) => other.type === channel.type && other.pattern === channel.pattern)
    if (clash) throw new CalderaError('channel_duplicate', `Two ${channel.type} channels are "${channel.pattern}".`)
    const caps = manager.capabilities()
    if (channel.type === 'presence' && !caps.presence) {
      throw new BootError('broadcast_presence_unsupported', `Channel "${channel.pattern}" is a presence channel, but the "${manager.defaultName}" connection's driver has no presence.`)
    }
    if (channel.options.clientEvents && !caps.clientEvents) {
      throw new BootError('broadcast_client_events_unsupported', `Channel "${channel.pattern}" has clientEvents, but the "${manager.defaultName}" connection's driver doesn't relay them.`)
    }
    channels.push(channel)
  }
  for (const channel of options.channels ?? []) register(channel)

  const names = (on: ChannelRef | string | readonly (ChannelRef | string)[]) => {
    const list = (Array.isArray(on) ? on : [on]) as (ChannelRef | string)[]
    if (!list.length) throw new CalderaError('broadcast_no_channels', 'A broadcast needs at least one channel.')
    return [...new Set(list.map((target) => (typeof target === 'string' ? target : target.name)))]
  }

  const message = (on: ChannelRef | string | readonly (ChannelRef | string)[], event: string, data: unknown, except: string | undefined, connection?: N): BroadcastMessage => {
    const json = JSON.stringify(data ?? null)
    const limit = manager.capabilities(connection).maxPayloadBytes
    const bytes = new TextEncoder().encode(json).length
    if (limit !== null && bytes > limit) {
      throw new CalderaError('broadcast_payload_too_large', `Broadcast "${event}" is ${bytes} bytes; the ${connection ?? manager.defaultName} connection takes at most ${limit}. Send an id and let the browser fetch the rest.`)
    }
    return { channels: names(on), event, data: json, ...(except ? { socketId: except } : {}) }
  }

  const deliver = async (sent: BroadcastMessage, connection?: N) => {
    if (fake) {
      fake.sent.push({ event: sent.event, channels: [...sent.channels], data: JSON.parse(sent.data), socketId: sent.socketId })
      return
    }
    await manager.use(connection).publish(sent)
  }

  const currentSocket = () => {
    const header = options.current?.()?.req.header('x-socket-id')
    return header && SOCKET_ID.test(header) ? header : undefined
  }

  const background = (work: Promise<unknown>, event: string) => {
    const tracked = work.catch((error: unknown) => {
      console.error(`[caldera] broadcast "${event}" failed:`, error)
      const report = fromGlobal<(entry: Record<string, unknown>) => void>('caldera.dev.reportError')
      report?.({ source: 'broadcast', event, message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) })
    })
    pending.add(tracked)
    void tracked.finally(() => pending.delete(tracked))
    try {
      // Hono's executionCtx getter throws on runtimes without one (Node).
      options.current?.()?.executionCtx.waitUntil(tracked)
    } catch {}
  }

  const job = {
    kind: 'caldera.job',
    name: BROADCAST_JOB,
    payload: jobPayload,
    queue: 'default',
    tries: 3,
    backoff: [5, 30, 120],
    timeout: 30,
    retryUntil: null,
    unique: null,
    middleware: [],
    failed: undefined,
    with: (payload: unknown) => ({ job, payload }),
    fromEvent: () => {
      throw new CalderaError('not_supported', 'The broadcast job is not an event listener.')
    },
    async handle(input: z.infer<typeof jobPayload>) {
      await deliver({ channels: input.channels, event: input.event, data: input.data, ...(input.socketId ? { socketId: input.socketId } : {}) }, input.connection as N | undefined)
    },
  }

  const broadcaster: Broadcaster<N> = {
    manager,
    channels,
    services: {} as RegisteredServices,
    job,
    register(...list) {
      for (const channel of list) register(channel)
    },
    find(name) {
      for (const channel of channels) {
        const params = channel.match(name)
        if (params) return { channel, params }
      }
      return undefined
    },
    async send(on, event, data, sendOptions = {}) {
      await deliver(message(on, event, data, sendOptions.except, sendOptions.connection), sendOptions.connection)
    },
    async broadcast(event, payload, broadcastOptions = {}) {
      const spec = event.broadcast
      if (!spec) throw new CalderaError('event_not_broadcast', `Event "${event.name}" has no \`broadcast\` option.`)
      // Built now, so a bad channel or an oversized payload fails where the event is emitted.
      const sent = message(spec.on(payload), spec.as ?? event.name, spec.with ? spec.with(payload) : payload, broadcastOptions.toOthers ? currentSocket() : undefined)
      const queue = spec.queue && !fake ? (options.queue?.() ?? fromGlobal<QueueLike>('caldera.queue.default')) : undefined
      if (spec.queue && !fake && !queue) throw new CalderaError('no_queue', `Broadcast "${event.name}" has \`queue: true\`, which needs queueProvider() from @caldera-js/queue.`)
      // After the transaction commits, so browsers that refetch see the change (and nothing on rollback).
      await afterCommit(() => (fake ? deliver(sent) : queue ? queue.dispatch(job, sent) : background(deliver(sent), sent.event)))
    },
    prepare(on, event, data, prepareOptions = {}) {
      const sent = message(on, event, data, prepareOptions.toOthers ? currentSocket() : undefined)
      return () => {
        if (fake) void deliver(sent)
        else background(deliver(sent), sent.event)
      }
    },
    async authorize(request) {
      const found = broadcaster.find(request.channel)
      if (!found) {
        return { allowed: false, status: 403, reason: 'no_channel', message: `No channel in src/channels matches "${request.channel}".` }
      }
      const { channel, params } = found
      if (channel.type === 'public') return { allowed: false, status: 403, reason: 'public', message: `"${request.channel}" is public: it needs no authorization.`, pattern: channel.pattern }
      if (!request.user && !channel.options.guests) return { allowed: false, status: 401, reason: 'guest', message: 'Sign in to join this channel.', pattern: channel.pattern }
      const bound: Record<string, unknown> = {}
      for (const [param, binder] of Object.entries((channel.options.bind ?? {}) as Record<string, ((value: string) => Promise<unknown>) | { findByRouteKey(value: string): Promise<unknown> }>)) {
        const row = typeof binder === 'function' ? await binder(params[param]!) : await binder.findByRouteKey(params[param]!)
        if (row === undefined || row === null) return { allowed: false, status: 403, reason: 'not_found', message: `No ${param} "${params[param]}".`, pattern: channel.pattern }
        bound[param] = row
      }
      const gate =
        request.gate ??
        new Proxy({}, {
          get() {
            throw new CalderaError('no_gate', `Channel "${channel.pattern}" uses \`gate\`, which needs authorizationProvider() from @caldera-js/auth.`)
          },
        })
      const ctx = { ...bound, user: request.user, params, gate, c: request.c }
      if (!(await (channel.options.authorize as (ctx: unknown) => boolean | Promise<boolean>)(ctx))) {
        return { allowed: false, status: 403, reason: 'denied', message: `authorize() refused "${request.channel}".`, pattern: channel.pattern }
      }
      if (channel.type !== 'presence') return { allowed: true, channel: request.channel, pattern: channel.pattern, type: 'private' }
      const info = ((await (channel.options.member as ((ctx: unknown) => unknown) | undefined)?.(ctx)) ?? {}) as Record<string, unknown>
      const id = info.id ?? request.user?.id
      if (id === undefined || id === null) {
        throw new CalderaError('broadcast_member_id', `Presence channel "${channel.pattern}": member() must return an \`id\` for guests.`)
      }
      return { allowed: true, channel: request.channel, pattern: channel.pattern, type: 'presence', member: { user_id: String(id), user_info: info } }
    },
    sign(socketId, result) {
      if (!SOCKET_ID.test(socketId)) throw new CalderaError('broadcast_socket_invalid', `"${socketId}" isn't a socket id.`)
      return manager.use().sign(socketId, result.channel, result.member ? JSON.stringify(result.member) : undefined)
    },
    client(connection) {
      const c = options.current?.()
      return manager.use(connection).client(c ? new URL(c.req.url) : undefined)
    },
    async flush() {
      while (pending.size) await Promise.all([...pending])
    },
    fake() {
      const state = { sent: [] as SentBroadcast[] }
      fake = state
      const describe = () => (state.sent.length ? state.sent.map((s) => `${s.event} on ${s.channels.join(', ')}`).join('; ') : 'nothing')
      const nameOf = (event: AnyEvent) => event.broadcast?.as ?? event.name
      return {
        sent: () => state.sent,
        assertBroadcast(event, match = {}) {
          const on = match.on === undefined ? undefined : typeof match.on === 'string' ? match.on : match.on.name
          const found = state.sent.some((s) => s.event === nameOf(event) && (!on || s.channels.includes(on)) && (!match.data || match.data(s.data as never)))
          if (!found) throw new CalderaError('assertion_failed', `Expected "${nameOf(event)}" to be broadcast${on ? ` on ${on}` : ''}${match.data ? ' with matching data' : ''}. Broadcast: ${describe()}.`)
        },
        assertNotBroadcast(event) {
          if (state.sent.some((s) => s.event === nameOf(event))) throw new CalderaError('assertion_failed', `Expected "${nameOf(event)}" not to be broadcast. Broadcast: ${describe()}.`)
        },
        assertNothingBroadcast() {
          if (state.sent.length) throw new CalderaError('assertion_failed', `Expected no broadcasts. Broadcast: ${describe()}.`)
        },
        restore() {
          if (fake === state) fake = undefined
        },
      }
    },
  }
  return broadcaster
}

// The app's database, as @caldera-js/db registers it, read without depending on it.
async function afterCommit(callback: () => unknown) {
  const resolver = fromGlobal<() => { afterCommit(cb: () => unknown): Promise<void> }>('caldera.db.defaultDatabase')
  let db: { afterCommit(cb: () => unknown): Promise<void> } | undefined
  try {
    db = resolver?.()
  } catch {
    db = undefined
  }
  if (db) await db.afterCommit(callback)
  else await callback()
}

const DEFAULT = Symbol.for('caldera.broadcast.default')
const registry = globalThis as { [DEFAULT]?: Broadcaster }

export function setDefaultBroadcaster(broadcaster: Broadcaster | undefined) {
  registry[DEFAULT] = broadcaster
}

export function defaultBroadcaster(): Broadcaster {
  const found = registry[DEFAULT]
  if (!found) throw new CalderaError('no_broadcast', 'Broadcasting isn’t set up: add broadcastProvider() from @caldera-js/broadcast to the app.')
  return found
}

type RegisteredPattern = BroadcastRegister extends { channels: infer C } ? keyof C & string : string

/**
 * A channel by its pattern, resolved when the broadcast is sent: `channel('posts.{post}', { post: id })`.
 * For models, whose channels bind the model (`bind: { post: Post }`): importing the channel into the
 * model file would be an import cycle. Patterns and parameters are typed from src/channels.
 */
export function channel<P extends RegisteredPattern>(pattern: P, params: ChannelParams<P>): ChannelRef<P> {
  return {
    kind: 'caldera.channel-ref',
    pattern,
    get name() {
      const found = defaultBroadcaster().channels.find((c) => c.pattern === pattern)
      if (!found) throw new CalderaError('channel_missing', `No channel "${pattern}" in src/channels.`)
      return found.name(params as never)
    },
  }
}

/** `await broadcast(PostChannel.with({ postId }), 'post.updated', { title })`: an event that isn't a defined one. */
export function broadcast(on: ChannelRef | string | readonly (ChannelRef | string)[], event: string, data: unknown, options?: { except?: string }) {
  return defaultBroadcaster().send(on, event, data, options)
}

/**
 * Registers `broadcast`: `broadcastProvider((app) => app.config.broadcast, { channels })`, with
 * `channels` from `.caldera/channels.gen.ts` (src/channels). Broadcast events then reach browsers.
 */
export function broadcastProvider<const N extends string>(
  resolve: (app: RegisterContext<unknown>) => BroadcastConfig<N>,
  options: { channels?: readonly AnyChannel[]; drivers?: readonly DriverDefinition<BroadcastDriver, BroadcastCapabilities>[] } = {},
) {
  let queue: QueueLike | undefined
  return defineProvider({
    name: 'broadcast',
    register: (app) => {
      const broadcaster = createBroadcaster(resolve(app), { ...options, queue: () => queue, current: () => app.current()?.context })
      setDefaultBroadcaster(broadcaster as never)
      return { broadcast: broadcaster }
    },
    boot: ({ services }) => {
      services.broadcast.services = services as never
      queue = (services as { queue?: QueueLike }).queue
      queue?.register(services.broadcast.job)
    },
    shutdown: async ({ services }) => {
      await services.broadcast.flush()
      await services.broadcast.manager.purge()
    },
  })
}

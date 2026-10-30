import { CalderaError, defineDriver } from '@caldera/core'
import { z } from 'zod'
import { signSubscription, type BroadcastCapabilities, type BroadcastDriver } from './driver.js'
import { createHub, newSocketId, type ConnectionState, type Hub, type HubConnection } from './hub.js'
import { signedPost } from './pusher.js'

// Workers' WebSocket and Durable Object APIs, typed structurally (no @cloudflare/workers-types needed).
interface WorkerWebSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
interface HubState {
  acceptWebSocket(socket: WorkerWebSocket): void
  getWebSockets(): WorkerWebSocket[]
  setWebSocketAutoResponse(pair: unknown): void
}
/** A Durable Object namespace binding (`env.BROADCAST_HUB`). */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
}
/** The env the hub reads: the same app id, key and secret as the durable-object connection. */
export interface BroadcastHubEnv {
  BROADCAST_APP_ID: string
  BROADCAST_KEY: string
  BROADCAST_SECRET: string
}

const workers = globalThis as unknown as {
  WebSocketPair: new () => { 0: WorkerWebSocket; 1: WorkerWebSocket }
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown
}

/**
 * The realtime server on Cloudflare: a Durable Object speaking the pusher protocol, so browsers use
 * pusher-js as with Pusher or Reverb. Sockets use the Hibernation API: idle connections cost nothing,
 * pings are answered without waking it, and each socket's subscriptions live in its attachment, so
 * they survive the object being evicted. One object (named "hub") holds every connection.
 *
 * In src/worker.ts: `export { BroadcastHub } from '@caldera/broadcast/cloudflare'`, and route
 * requests with `broadcastHubRoute(request, env)` before the app.
 */
export class BroadcastHub {
  private readonly hub: Hub
  private readonly connections = new WeakMap<WorkerWebSocket, HubConnection>()

  constructor(
    private readonly ctx: HubState,
    env: BroadcastHubEnv,
  ) {
    for (const name of ['BROADCAST_APP_ID', 'BROADCAST_KEY', 'BROADCAST_SECRET'] as const) {
      if (!env[name]) throw new CalderaError('broadcast_hub_env', `BroadcastHub needs ${name} (a secret: \`wrangler secret put ${name}\`, or [vars]).`)
    }
    // pusher-js pings after a quiet spell; answered by the runtime, so the object can stay asleep.
    ctx.setWebSocketAutoResponse(new workers.WebSocketRequestResponsePair('{"event":"pusher:ping","data":{}}', '{"event":"pusher:pong","data":{}}'))
    this.hub = createHub({
      appId: env.BROADCAST_APP_ID,
      key: env.BROADCAST_KEY,
      secret: env.BROADCAST_SECRET,
      connections: () => ctx.getWebSockets().map((socket) => this.connection(socket)),
    })
  }

  // After hibernation the object is new: connections are rebuilt from each socket's attachment.
  private connection(socket: WorkerWebSocket): HubConnection {
    let connection = this.connections.get(socket)
    if (!connection) {
      const state = (socket.deserializeAttachment() as ConnectionState | null) ?? { socketId: newSocketId(), channels: {} }
      connection = {
        state,
        send: (message) => {
          try {
            socket.send(message)
          } catch {} // already closing
        },
        close: (code, reason) => socket.close(code, reason),
        save: () => socket.serializeAttachment(state),
      }
      this.connections.set(socket, connection)
    }
    return connection
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new workers.WebSocketPair()
      const server = pair[1]
      this.ctx.acceptWebSocket(server)
      const connection = this.connection(server)
      connection.save()
      this.hub.open(connection)
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
    }
    return (await this.hub.api(request)) ?? new Response('{"error":"Not found."}', { status: 404, headers: { 'content-type': 'application/json' } })
  }

  async webSocketMessage(socket: WorkerWebSocket, message: string | ArrayBuffer) {
    await this.hub.receive(this.connection(socket), typeof message === 'string' ? message : new TextDecoder().decode(message))
  }

  webSocketClose(socket: WorkerWebSocket) {
    this.hub.close(this.connection(socket))
    try {
      socket.close(1000, 'Closed')
    } catch {} // the runtime may have completed the close already
  }

  webSocketError(socket: WorkerWebSocket) {
    this.webSocketClose(socket)
  }
}

/**
 * Sends the hub's requests to it, from src/worker.ts before the app: browsers' WebSocket upgrades at
 * `/app/{key}` and signed publishes at `/apps/{appId}/events` (so apps hosted elsewhere, on Vercel
 * or Node, can use it too). Anything else is undefined, for the app to answer.
 */
export function broadcastHubRoute(request: Request, env: { BROADCAST_HUB?: DurableObjectNamespaceLike } & Partial<BroadcastHubEnv>): Promise<Response> | undefined {
  const { pathname } = new URL(request.url)
  const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  const ours = (upgrade && pathname.startsWith('/app/')) || (request.method === 'POST' && /^\/apps\/[^/]+\/(events|batch_events)$/.test(pathname))
  if (!ours) return undefined
  if (!env.BROADCAST_HUB) return Promise.resolve(new Response('BROADCAST_HUB is not bound (wrangler.toml [[durable_objects.bindings]]).', { status: 500 }))
  return env.BROADCAST_HUB.get(env.BROADCAST_HUB.idFromName('hub')).fetch(request)
}

const schema = z.object({
  /** The Durable Object namespace binding: `env.BROADCAST_HUB`. */
  binding: z.custom<DurableObjectNamespaceLike>((value) => typeof (value as DurableObjectNamespaceLike | undefined)?.idFromName === 'function', 'a Durable Object namespace binding (env.BROADCAST_HUB)'),
  appId: z.string().min(1),
  key: z.string().min(1),
  secret: z.string().min(1),
  maxPayloadBytes: z.number().int().positive().default(10_240),
  timeoutMs: z.number().int().positive().default(5000),
})

/**
 * Broadcasting on Cloudflare Workers through `BroadcastHub`: publishes go straight to the Durable
 * Object over its binding; browsers connect to the app's own origin at `/app/{key}`.
 * `{ driver: 'durable-object', binding: env.BROADCAST_HUB, appId, key, secret }`.
 */
export const durableObjectDriver = defineDriver<BroadcastDriver, BroadcastCapabilities, z.output<typeof schema>>({
  name: 'durable-object',
  schema,
  capabilities: (config) => ({ presence: true, clientEvents: true, maxPayloadBytes: config.maxPayloadBytes }),
  create(config) {
    const stub = () => config.binding.get(config.binding.idFromName('hub'))
    return {
      publish: signedPost({ base: 'https://broadcast-hub', appId: config.appId, key: config.key, secret: config.secret, timeoutMs: config.timeoutMs }, (url, init) => stub().fetch(url, init)),
      sign: (socketId, channel, channelData) => signSubscription(config.key, config.secret, socketId, channel, channelData),
      client(url) {
        if (!url) return undefined
        const tls = url.protocol === 'https:'
        const port = url.port ? Number(url.port) : undefined
        return { key: config.key, cluster: '', wsHost: url.hostname, ...(port ? (tls ? { wssPort: port } : { wsPort: port }) : {}), forceTLS: tls, enabledTransports: ['ws', 'wss'] }
      },
    }
  },
})

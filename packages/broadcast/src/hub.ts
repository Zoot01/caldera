import { hmacHex } from './driver.js'
import { md5 } from './md5.js'

/**
 * A pusher-protocol server (version 7), written once for every host: a Node process (`caldera
 * broadcast:serve`, and `caldera dev`) and a Cloudflare Durable Object. Browsers connect with
 * pusher-js; the app publishes with the pusher driver's signed HTTP API. The hub keeps nothing but
 * each connection's own state, which a Durable Object stores on the socket so it survives hibernation.
 */

/** What one connection is subscribed to; presence channels keep the member it joined as. */
export interface ConnectionState {
  socketId: string
  channels: Record<string, { userId: string; userInfo: unknown } | null>
}

/** A socket, as the host gives it to the hub. */
export interface HubConnection {
  readonly state: ConnectionState
  send(message: string): void
  close(code: number, reason: string): void
  /** Called after the state changes (a Durable Object writes it to the socket's attachment). */
  save(): void
}

export interface HubOptions {
  appId: string
  key: string
  /** Or a promise of it (derived from APP_KEY). */
  secret: string | Promise<string>
  /** Every open connection, for fan-out and presence. */
  connections(): Iterable<HubConnection>
  /** Largest message accepted, from the app or a client. Default 10KB, as Pusher. */
  maxPayloadBytes?: number
  /** Seconds of silence before pusher-js pings. Default 30. */
  activityTimeout?: number
}

const encoder = new TextEncoder()
const size = (text: string) => encoder.encode(text).length
const isPrivate = (channel: string) => channel.startsWith('private-') || channel.startsWith('presence-')
const VALID_CHANNEL = /^[A-Za-z0-9_\-=@,.;]{1,164}$/

export function createHub(options: HubOptions) {
  const maxPayloadBytes = options.maxPayloadBytes ?? 10_240
  // Client events: at most 10 per second per connection, as Pusher. In memory only (it's a rate, not state).
  const clientEventTimes = new Map<string, number[]>()

  const send = (connection: HubConnection, event: string, data: unknown, channel?: string) =>
    connection.send(JSON.stringify({ event, ...(channel ? { channel } : {}), data: typeof data === 'string' ? data : JSON.stringify(data) }))
  const error = (connection: HubConnection, code: number | null, message: string) => connection.send(JSON.stringify({ event: 'pusher:error', data: { code, message } }))

  const subscribers = function* (channel: string) {
    for (const connection of options.connections()) if (channel in connection.state.channels) yield connection
  }
  const members = (channel: string, except?: HubConnection) => {
    const found = new Map<string, unknown>()
    for (const connection of subscribers(channel)) {
      const member = connection.state.channels[channel]
      if (member && connection !== except) found.set(member.userId, member.userInfo)
    }
    return found
  }

  const subscribe = async (connection: HubConnection, data: { channel?: unknown; auth?: unknown; channel_data?: unknown }) => {
    const channel = typeof data.channel === 'string' ? data.channel : ''
    const refuse = (message: string, status = 401) => connection.send(JSON.stringify({ event: 'pusher:subscription_error', channel, data: { type: 'AuthError', error: message, status } }))
    if (!VALID_CHANNEL.test(channel)) return error(connection, 4009, `"${channel}" isn't a valid channel name.`)
    if (channel in connection.state.channels) return
    if (isPrivate(channel)) {
      const channelData = typeof data.channel_data === 'string' ? data.channel_data : undefined
      const expected = `${options.key}:${await hmacHex(await options.secret, channelData === undefined ? `${connection.state.socketId}:${channel}` : `${connection.state.socketId}:${channel}:${channelData}`)}`
      if (typeof data.auth !== 'string' || !timingSafeEqual(data.auth, expected)) return refuse('The subscription signature is invalid.')
      if (channel.startsWith('presence-')) {
        let member: { user_id?: unknown; user_info?: unknown }
        try {
          member = JSON.parse(channelData ?? '') as typeof member
        } catch {
          return refuse('Presence channel_data must be JSON.')
        }
        if (typeof member.user_id !== 'string' && typeof member.user_id !== 'number') return refuse('Presence channel_data needs a user_id.')
        const userId = String(member.user_id)
        const before = members(channel)
        connection.state.channels[channel] = { userId, userInfo: member.user_info ?? null }
        connection.save()
        const now = members(channel)
        send(connection, 'pusher_internal:subscription_succeeded', { presence: { ids: [...now.keys()], hash: Object.fromEntries(now), count: now.size } }, channel)
        // A user with two tabs is one member: only their first connection announces them.
        if (!before.has(userId)) {
          for (const other of subscribers(channel)) if (other !== connection) send(other, 'pusher_internal:member_added', { user_id: userId, user_info: member.user_info ?? null }, channel)
        }
        return
      }
    }
    connection.state.channels[channel] = null
    connection.save()
    send(connection, 'pusher_internal:subscription_succeeded', {}, channel)
  }

  const unsubscribe = (connection: HubConnection, channel: string, save = true) => {
    if (!(channel in connection.state.channels)) return
    const member = connection.state.channels[channel]
    delete connection.state.channels[channel]
    if (save) connection.save()
    if (member && !members(channel, connection).has(member.userId)) {
      for (const other of subscribers(channel)) if (other !== connection) send(other, 'pusher_internal:member_removed', { user_id: member.userId }, channel)
    }
  }

  const clientEvent = (connection: HubConnection, message: { event: string; channel?: unknown; data?: unknown }, raw: string) => {
    const channel = typeof message.channel === 'string' ? message.channel : ''
    if (!isPrivate(channel) || !(channel in connection.state.channels)) return error(connection, null, `Client events need a private or presence channel you've joined ("${channel}").`)
    if (size(raw) > maxPayloadBytes) return error(connection, 4301, `Client event over ${maxPayloadBytes} bytes.`)
    const now = Date.now()
    const recent = (clientEventTimes.get(connection.state.socketId) ?? []).filter((t) => now - t < 1000)
    if (recent.length >= 10) return error(connection, 4301, 'Over 10 client events per second.')
    clientEventTimes.set(connection.state.socketId, [...recent, now])
    const member = connection.state.channels[channel]
    const out = JSON.stringify({ event: message.event, channel, data: message.data, ...(member ? { user_id: member.userId } : {}) })
    for (const other of subscribers(channel)) if (other !== connection) other.send(out)
  }

  const deliver = (channels: readonly string[], event: string, data: string, except?: string) => {
    for (const channel of channels) {
      const out = JSON.stringify({ event, channel, data })
      for (const connection of subscribers(channel)) if (connection.state.socketId !== except) connection.send(out)
    }
  }

  return {
    /** A new connection: its state, and the handshake to send. */
    open(connection: HubConnection) {
      send(connection, 'pusher:connection_established', { socket_id: connection.state.socketId, activity_timeout: options.activityTimeout ?? 30 })
    },
    async receive(connection: HubConnection, raw: string) {
      if (size(raw) > maxPayloadBytes + 1024) return error(connection, 4301, 'Message too large.')
      let message: { event?: unknown; channel?: unknown; data?: unknown }
      try {
        message = JSON.parse(raw) as typeof message
      } catch {
        return error(connection, null, 'Messages are JSON.')
      }
      const event = typeof message.event === 'string' ? message.event : ''
      // Some clients send data as a JSON string.
      const data = typeof message.data === 'string' && event.startsWith('pusher:') ? safeParse(message.data) : message.data
      if (event === 'pusher:ping') return send(connection, 'pusher:pong', {})
      if (event === 'pusher:pong') return
      if (event === 'pusher:subscribe') return subscribe(connection, (data ?? {}) as never)
      if (event === 'pusher:unsubscribe') return unsubscribe(connection, String((data as { channel?: unknown } | undefined)?.channel ?? ''))
      if (event.startsWith('client-')) return clientEvent(connection, { ...message, event }, raw)
      return error(connection, null, `Unknown event "${event}".`)
    },
    /** The connection closed: leave every channel (presence members announce they left). */
    close(connection: HubConnection) {
      for (const channel of Object.keys(connection.state.channels)) unsubscribe(connection, channel, false)
      clientEventTimes.delete(connection.state.socketId)
    },
    /**
     * The HTTP API the pusher driver publishes to: POST /apps/{appId}/events and /batch_events, signed
     * with the app secret. Anything else is undefined, for the host to answer.
     */
    async api(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      const route = /^\/apps\/([^/]+)\/(events|batch_events)$/.exec(url.pathname)
      if (!route || request.method !== 'POST') return undefined
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (route[1] !== options.appId) return json({ error: 'Unknown app.' }, 404)
      const body = await request.text()
      const query = new URLSearchParams(url.search)
      const signature = query.get('auth_signature') ?? ''
      query.delete('auth_signature')
      query.sort()
      const timestamp = Number(query.get('auth_timestamp'))
      const expected = await hmacHex(await options.secret, `POST\n${url.pathname}\n${decodeURIComponent(query.toString())}`)
      if (query.get('auth_key') !== options.key || !timingSafeEqual(signature, expected) || query.get('body_md5') !== md5(body)) return json({ error: 'Invalid signature.' }, 401)
      if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 600) return json({ error: 'Timestamp expired.' }, 401)
      const parsed = safeParse(body) as { name?: unknown; data?: unknown; channels?: unknown; channel?: unknown; socket_id?: unknown; batch?: unknown } | undefined
      const events = route[2] === 'batch_events' ? (Array.isArray(parsed?.batch) ? parsed.batch : []) : [parsed]
      for (const item of events as (typeof parsed)[]) {
        const channels = Array.isArray(item?.channels) ? item.channels : typeof item?.channel === 'string' ? [item.channel] : []
        if (typeof item?.name !== 'string' || typeof item.data !== 'string' || !channels.length || !channels.every((c) => typeof c === 'string' && VALID_CHANNEL.test(c))) {
          return json({ error: 'Expected name, data (a string) and channels.' }, 400)
        }
        if (size(item.data) > maxPayloadBytes) return json({ error: `Event data over ${maxPayloadBytes} bytes.` }, 413)
        deliver(channels as string[], item.name, item.data, typeof item.socket_id === 'string' ? item.socket_id : undefined)
      }
      return json({})
    },
  }
}
export type Hub = ReturnType<typeof createHub>

/** A pusher-js socket id: two random numbers. */
export function newSocketId(): string {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2))
  return `${a}.${b}`
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

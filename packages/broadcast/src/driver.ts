import { defineDriver } from '@caldera/core'

/** What a broadcast driver can do; a channel that needs more fails at boot. */
export interface BroadcastCapabilities {
  /** Presence channels (who's here). */
  presence: boolean
  /** Client events (whispers) between browsers. */
  clientEvents: boolean
  /** Largest event payload in bytes, or null for no limit. */
  maxPayloadBytes: number | null
}

/** One message to send: an event on some channels, already serialized. */
export interface BroadcastMessage {
  channels: readonly string[]
  event: string
  /** JSON. */
  data: string
  /** Skip this connection (the sender, for `toOthers`). */
  socketId?: string
}

/** What the browser needs to connect (no secrets): pusher-js options. */
export interface ClientConfig {
  /** The pusher-js key. */
  key: string
  /** Pusher's cluster, or the host of a Pusher-compatible server (Soketi, Reverb, `caldera broadcast:serve`, the Durable Object). */
  cluster?: string
  wsHost?: string
  wsPort?: number
  wssPort?: number
  forceTLS?: boolean
  /** `ws` and `wss` (Pusher also offers xhr fallbacks). */
  enabledTransports?: ('ws' | 'wss')[]
}

export interface BroadcastDriver {
  publish(message: BroadcastMessage): Promise<void>
  /**
   * Signs a subscription the app allowed, for the pusher protocol: `{ auth: 'key:signature' }`, plus
   * `channel_data` for presence. Drivers that deliver nothing (log, null) return an unsigned answer.
   */
  sign(socketId: string, channel: string, channelData?: string): Promise<{ auth: string; channel_data?: string }>
  /** The browser's connection options, or undefined when there's nothing to connect to. */
  client(): ClientConfig | undefined
}

/** Writes every broadcast to the console: development without a realtime server. */
export const logDriver = defineDriver<BroadcastDriver, BroadcastCapabilities>({
  name: 'log',
  capabilities: { presence: true, clientEvents: true, maxPayloadBytes: null },
  create: () => ({
    async publish(message) {
      console.log(`[caldera] broadcast ${message.event} on ${message.channels.join(', ')}${message.socketId ? ` (except ${message.socketId})` : ''}: ${message.data}`)
    },
    sign: async (_socketId, _channel, channelData) => ({ auth: 'log:unsigned', ...(channelData ? { channel_data: channelData } : {}) }),
    client: () => undefined,
  }),
})

/** Drops every broadcast. */
export const nullDriver = defineDriver<BroadcastDriver, BroadcastCapabilities>({
  name: 'null',
  capabilities: { presence: true, clientEvents: true, maxPayloadBytes: null },
  create: () => ({
    publish: async () => {},
    sign: async (_socketId, _channel, channelData) => ({ auth: 'null:unsigned', ...(channelData ? { channel_data: channelData } : {}) }),
    client: () => undefined,
  }),
})

/** HMAC-SHA256 as lowercase hex, with Web Crypto (every runtime). */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The pusher protocol's subscription signature: HMAC of `socket_id:channel[:channel_data]`. */
export async function signSubscription(key: string, secret: string, socketId: string, channel: string, channelData?: string) {
  const signature = await hmacHex(secret, channelData === undefined ? `${socketId}:${channel}` : `${socketId}:${channel}:${channelData}`)
  return { auth: `${key}:${signature}`, ...(channelData === undefined ? {} : { channel_data: channelData }) }
}

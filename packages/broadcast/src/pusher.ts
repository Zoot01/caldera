import { CalderaError, defineDriver } from '@caldera/core'
import { z } from 'zod'
import { hmacHex, signSubscription, type BroadcastCapabilities, type BroadcastDriver } from './driver.js'
import { md5 } from './md5.js'

const schema = z.object({
  appId: z.string().min(1),
  key: z.string().min(1),
  secret: z.string().min(1),
  /** Hosted Pusher: the app's cluster (`eu`, `mt1`…). */
  cluster: z.string().optional(),
  /** A Pusher-compatible server (Soketi, Reverb, `caldera broadcast:serve`): where the app publishes. */
  host: z.string().optional(),
  port: z.coerce.number().int().optional(),
  scheme: z.enum(['http', 'https']).optional(),
  /** Where browsers connect, when it isn't `host` (a public hostname in front of a private one). */
  client: z.object({ host: z.string().optional(), port: z.coerce.number().int().optional(), scheme: z.enum(['http', 'https']).optional() }).optional(),
  /** Pusher refuses events over 10KB; self-hosted servers set their own limit. */
  maxPayloadBytes: z.number().int().positive().nullable().optional(),
  timeoutMs: z.number().int().positive().default(5000),
})
export type PusherConfig = z.input<typeof schema>

/**
 * The pusher protocol: hosted Pusher, or a compatible server (Soketi, Laravel Reverb, `caldera
 * broadcast:serve`, the Cloudflare Durable Object). Publishing is one signed HTTP POST, so it works on
 * every runtime; browsers connect with pusher-js.
 */
export const pusherDriver = defineDriver<BroadcastDriver, BroadcastCapabilities, z.output<typeof schema>>({
  name: 'pusher',
  schema,
  capabilities: (config) => ({ presence: true, clientEvents: true, maxPayloadBytes: config.maxPayloadBytes === undefined ? (config.host ? null : 10_240) : config.maxPayloadBytes }),
  create(config) {
    if (!config.host && !config.cluster) throw new CalderaError('broadcast_pusher_host', 'The pusher driver needs `cluster` (hosted Pusher) or `host` (Soketi, Reverb, your own server).')
    const scheme = config.scheme ?? (config.host ? 'http' : 'https')
    const base = config.host ? `${scheme}://${config.host}${config.port ? `:${config.port}` : ''}` : `https://api-${config.cluster}.pusher.com`
    const post = async (path: string, body: string) => {
      const query = new URLSearchParams({ auth_key: config.key, auth_timestamp: String(Math.floor(Date.now() / 1000)), auth_version: '1.0', body_md5: md5(body) })
      query.sort()
      const signature = await hmacHex(config.secret, `POST\n${path}\n${decodeURIComponent(query.toString())}`)
      const response = await fetch(`${base}${path}?${query}&auth_signature=${signature}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      if (!response.ok) {
        throw new CalderaError('broadcast_failed', `${base} refused the broadcast (${response.status}): ${(await response.text()).slice(0, 300)}`, { status: response.status })
      }
    }
    return {
      async publish(message) {
        // The API takes at most 100 channels per event.
        for (let i = 0; i < message.channels.length; i += 100) {
          const body = JSON.stringify({ name: message.event, channels: message.channels.slice(i, i + 100), data: message.data, ...(message.socketId ? { socket_id: message.socketId } : {}) })
          await post(`/apps/${config.appId}/events`, body)
        }
      },
      sign: (socketId, channel, channelData) => signSubscription(config.key, config.secret, socketId, channel, channelData),
      client() {
        if (!config.host) return { key: config.key, cluster: config.cluster!, forceTLS: true }
        const host = config.client?.host ?? config.host
        const port = config.client?.port ?? config.port
        const tls = (config.client?.scheme ?? scheme) === 'https'
        return { key: config.key, cluster: '', wsHost: host, ...(port ? (tls ? { wssPort: port } : { wsPort: port }) : {}), forceTLS: tls, enabledTransports: ['ws', 'wss'] }
      },
    }
  },
})

import { CalderaError, defineDriver } from '@caldera-js/core'
import { z } from 'zod'
import type { BroadcastCapabilities, BroadcastDriver } from './driver.js'
import { newSocketId, type HubCluster } from './hub.js'

/** One browser's event stream and the channels it joined. */
interface Stream {
  readonly id: string
  readonly channels: Set<string>
  send(text: string): void
}

/** What the routes need from an `sse` connection, besides publishing. */
export interface SseHub {
  readonly kind: 'caldera.sse-hub'
  /** The `text/event-stream` response for a new browser. */
  open(signal?: AbortSignal): Response
  /** Adds a channel to a stream (after the app authorized it); false for an unknown stream. */
  join(streamId: string, channel: string): boolean
  leave(streamId: string, channel: string): void
  /** Ends every stream and the Redis connection. */
  shutdown(): Promise<void>
}

export function isSseHub(value: unknown): value is SseHub {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'caldera.sse-hub'
}

const schema = z.object({
  /** Where browsers open the stream; broadcastRoutes() serves it. */
  path: z.string().default('/_caldera/broadcast/sse'),
  /** redis://…: several app processes as one (ioredis). */
  redis: z.string().optional(),
  /** Seconds between keep-alive comments, under proxies' idle timeouts. */
  keepAliveSeconds: z.number().int().positive().default(15),
})

const encoder = new TextEncoder()

/**
 * Realtime from the app itself, over server-sent events: no realtime server to run. One stream per
 * browser carries every channel it joins (joins are authorized by the app, as for pusher). One-way:
 * no presence, no whispers. Node and Bun (a long-lived process holds the streams); several processes
 * share broadcasts over Redis. On serverless platforms a stream ends at the function's time limit
 * and the browser reconnects, missing what was sent meanwhile.
 */
export const sseDriver = defineDriver<BroadcastDriver & SseHub, BroadcastCapabilities, z.output<typeof schema>>({
  name: 'sse',
  schema,
  capabilities: { presence: false, clientEvents: false, maxPayloadBytes: null },
  create(config, context) {
    const streams = new Map<string, Stream>()
    const deliverHere = (channel: string, frame: string, except?: string) => {
      for (const stream of streams.values()) if (stream.channels.has(channel) && stream.id !== except) stream.send(frame)
    }
    let cluster: Promise<HubCluster & { close(): Promise<void> }> | undefined
    if (config.redis) {
      cluster = import('./redis.js').then(({ redisCluster }) => redisCluster({ url: config.redis!, appId: `sse:${context.name}` }))
      void cluster.then((c) => c.onFrame(deliverHere), (error: unknown) => console.error('[caldera] broadcast sse: Redis unavailable', error))
    }
    return {
      kind: 'caldera.sse-hub',
      async publish(message) {
        for (const channel of message.channels) {
          const frame = `data: ${JSON.stringify({ channel, event: message.event, data: message.data })}\n\n`
          deliverHere(channel, frame, message.socketId)
          ;(await cluster)?.fanOut(channel, frame, message.socketId)
        }
      },
      sign: async () => {
        throw new CalderaError('broadcast_sse_no_signing', 'The sse driver joins channels through its own route; there is nothing to sign.')
      },
      client: () => ({ transport: 'sse', url: config.path }),
      open(signal) {
        let stream: Stream | undefined
        let timer: ReturnType<typeof setInterval> | undefined
        const close = () => {
          if (stream) streams.delete(stream.id)
          clearInterval(timer)
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const id = newSocketId()
            stream = {
              id,
              channels: new Set(),
              send: (text) => {
                try {
                  controller.enqueue(encoder.encode(text))
                } catch {
                  close()
                }
              },
            }
            streams.set(id, stream)
            // The id is the stream's socket id: joins name it, and X-Socket-ID (toOthers) uses it.
            stream.send(`retry: 2000\nevent: connected\ndata: ${JSON.stringify({ id })}\n\n`)
            timer = setInterval(() => stream?.send(': ping\n\n'), config.keepAliveSeconds * 1000)
            signal?.addEventListener('abort', () => {
              close()
              try {
                controller.close()
              } catch {}
            })
          },
          cancel: close,
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } })
      },
      join(streamId, channel) {
        const stream = streams.get(streamId)
        if (!stream) return false
        stream.channels.add(channel)
        return true
      },
      leave(streamId, channel) {
        streams.get(streamId)?.channels.delete(channel)
      },
      async shutdown() {
        streams.clear()
        await (await cluster)?.close()
      },
    }
  },
  close: (instance) => instance.shutdown(),
})

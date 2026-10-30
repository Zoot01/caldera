import { Hono, type Context } from 'hono'
import type { Broadcaster } from './broadcaster.js'
import { isSseHub } from './sse.js'

/**
 * POST `/_caldera/broadcast/auth` (pusher-js asks here before joining a private or presence channel),
 * and the sse driver's stream and joins (`/_caldera/broadcast/sse`).
 * The channel's `authorize` decides; an allowed subscription is signed for the realtime server. It
 * runs behind the app's middleware, so `originCheck()` guards it like any other POST (Laravel exempts it).
 */
export function broadcastRoutes(options: { path?: string; ssePath?: string } = {}): Hono {
  const ssePath = options.ssePath ?? '/_caldera/broadcast/sse'
  const broadcasterOf = (c: Context) => {
    const broadcaster = (c.var as { broadcast?: Broadcaster }).broadcast
    if (!broadcaster) throw new Error('broadcastRoutes() needs broadcastProvider() in the app (it provides c.var.broadcast).')
    return broadcaster
  }
  const sseHubOf = (c: Context) => {
    const hub = broadcasterOf(c).manager.use()
    return isSseHub(hub) ? hub : undefined
  }
  const userOf = (c: Context) => ((c.var as { user?: { id: string | number } | null }).user ?? null) as { id: string | number } | null
  return new Hono()
    // The sse driver: one event stream per browser, and joins the app authorizes.
    .get(ssePath, (c) => {
      const hub = sseHubOf(c)
      return hub ? hub.open(c.req.raw.signal) : c.notFound()
    })
    .post(`${ssePath}/join`, async (c) => {
      const hub = sseHubOf(c)
      if (!hub) return c.notFound()
      const body = await readBody(c)
      const stream = String(body.stream ?? '')
      const channel = String(body.channel ?? '')
      if (!/^\d+\.\d+$/.test(stream) || !/^[A-Za-z0-9_\-=@,.;]{1,164}$/.test(channel)) return refuse(c, 400, 'bad_request', 'Send stream and channel.')
      if (channel.startsWith('presence-')) return refuse(c, 400, 'bad_request', 'The sse driver has no presence channels.')
      if (channel.startsWith('private-')) {
        const result = await broadcasterOf(c).authorize({ channel, user: userOf(c), gate: (c.var as { gate?: unknown }).gate, c })
        if (!result.allowed) return result.status === 401 ? refuse(c, 401, 'unauthenticated', 'Sign in to join this channel.') : refuse(c, 403, 'forbidden', 'You can’t join this channel.')
      }
      if (!hub.join(stream, channel)) return refuse(c, 404, 'not_found', 'No such stream (it may have reconnected).')
      return c.json({ ok: true })
    })
    .post(`${ssePath}/leave`, async (c) => {
      const hub = sseHubOf(c)
      if (!hub) return c.notFound()
      const body = await readBody(c)
      hub.leave(String(body.stream ?? ''), String(body.channel ?? ''))
      return c.json({ ok: true })
    })
    // pusher-js asks here before joining a private or presence channel.
    .post(options.path ?? '/_caldera/broadcast/auth', async (c) => {
      const broadcaster = broadcasterOf(c)
      const body = await readBody(c)
      const socketId = String(body.socket_id ?? '')
      const channel = String(body.channel_name ?? '')
      if (!/^\d+\.\d+$/.test(socketId) || !channel) return refuse(c, 400, 'bad_request', 'Send socket_id and channel_name, as pusher-js does.')
      const result = await broadcaster.authorize({ channel, user: userOf(c), gate: (c.var as { gate?: unknown }).gate, c })
      if (!result.allowed) {
        // One answer for "no such channel", "no such row" and "not yours": the reason stays server-side.
        return result.status === 401 ? refuse(c, 401, 'unauthenticated', 'Sign in to join this channel.') : refuse(c, 403, 'forbidden', 'You can’t join this channel.')
      }
      return c.json(await broadcaster.sign(socketId, result))
    })
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? ''
  try {
    if (type.includes('application/json')) return ((await c.req.json()) ?? {}) as Record<string, unknown>
    return Object.fromEntries(new URLSearchParams(await c.req.text()))
  } catch {
    return {}
  }
}

function refuse(c: Context, status: 400 | 401 | 403 | 404, code: string, message: string) {
  return c.json({ error: { code, message, status, requestId: c.req.header('x-request-id') ?? '' } }, status)
}

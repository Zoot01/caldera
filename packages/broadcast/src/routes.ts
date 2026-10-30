import { Hono, type Context } from 'hono'
import type { Broadcaster } from './broadcaster.js'

/**
 * POST `/_caldera/broadcast/auth`: pusher-js asks here before joining a private or presence channel.
 * The channel's `authorize` decides; an allowed subscription is signed for the realtime server. It
 * runs behind the app's middleware, so `originCheck()` guards it like any other POST (Laravel exempts it).
 */
export function broadcastRoutes(options: { path?: string } = {}): Hono {
  return new Hono().post(options.path ?? '/_caldera/broadcast/auth', async (c) => {
    const broadcaster = (c.var as { broadcast?: Broadcaster }).broadcast
    if (!broadcaster) throw new Error('broadcastRoutes() needs broadcastProvider() in the app (it provides c.var.broadcast).')
    const body = await readBody(c)
    const socketId = String(body.socket_id ?? '')
    const channel = String(body.channel_name ?? '')
    if (!/^\d+\.\d+$/.test(socketId) || !channel) return refuse(c, 400, 'bad_request', 'Send socket_id and channel_name, as pusher-js does.')
    const user = ((c.var as { user?: { id: string | number } | null }).user ?? null) as { id: string | number } | null
    const result = await broadcaster.authorize({ channel, user, gate: (c.var as { gate?: unknown }).gate, c })
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

function refuse(c: Context, status: 400 | 401 | 403, code: string, message: string) {
  return c.json({ error: { code, message, status, requestId: c.req.header('x-request-id') ?? '' } }, status)
}

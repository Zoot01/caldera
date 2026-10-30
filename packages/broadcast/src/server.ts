import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { createHub, newSocketId, type HubConnection } from './hub.js'
import { redisCluster } from './redis.js'

export interface BroadcastServerOptions {
  appId: string
  key: string
  secret: string | Promise<string>
  port: number
  /** Default 127.0.0.1; `0.0.0.0` to accept other machines. */
  host?: string
  maxPayloadBytes?: number
  /** redis://…: run several servers as one (publishes, whispers and presence shared over Redis). */
  redis?: string
  /** With `redis`: seconds before a stopped node's presence members leave. Default 30. */
  nodeTtlSeconds?: number
}

/**
 * A pusher-protocol server on Node (`caldera broadcast:serve`; `caldera dev` starts one for you): what
 * Laravel Reverb is to Laravel. Browsers connect with pusher-js to `/app/{key}`; the app publishes
 * through the pusher driver. One process holds every connection; it needs nothing else running.
 */
export async function startBroadcastServer(options: BroadcastServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const connections = new Set<HubConnection>()
  const cluster = options.redis ? await redisCluster({ url: options.redis, appId: options.appId, ...(options.nodeTtlSeconds ? { nodeTtlSeconds: options.nodeTtlSeconds } : {}) }) : undefined
  const hub = createHub({ ...options, connections: () => connections, ...(cluster ? { cluster } : {}) })
  const closing = new Set<Promise<void>>()
  const sockets = new WebSocketServer({ noServer: true, maxPayload: (options.maxPayloadBytes ?? 10_240) + 4096 })

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/up')) return void res.writeHead(200, { 'content-type': 'text/plain' }).end('OK')
      const response = await hub.api(await toRequest(req, options.port))
      if (!response) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}')
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text())
    } catch (error) {
      console.error('[caldera] broadcast server error', error)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    sockets.handleUpgrade(req, socket, head, (ws) => {
      // pusher-js closes on 4001 without retrying: the key is wrong, retrying won't help.
      if (path !== `/app/${options.key}`) return ws.close(4001, `App key not found at ${path}.`)
      accept(ws)
    })
  })

  const accept = (ws: WebSocket) => {
    const connection: HubConnection = {
      state: { socketId: newSocketId(), channels: {} },
      send: (message) => ws.readyState === ws.OPEN && ws.send(message),
      close: (code, reason) => ws.close(code, reason),
      save: () => {},
    }
    connections.add(connection)
    hub.open(connection)
    ws.on('message', (data) => void hub.receive(connection, data.toString()).catch((error: unknown) => console.error('[caldera] broadcast message failed', error)))
    ws.on('close', () => {
      connections.delete(connection)
      const done = hub.close(connection).catch((error: unknown) => console.error('[caldera] broadcast close failed', error))
      closing.add(done)
      void done.finally(() => closing.delete(done))
    })
    ws.on('error', () => ws.terminate())
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve())
  })
  const port = (server.address() as { port: number }).port
  return {
    port,
    async close() {
      // Each connection leaves its channels (presence members announced, in Redis too) before the end.
      await new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate()
        sockets.close()
        server.close(() => resolve())
      })
      await Promise.all([...closing])
      await cluster?.close()
    },
  }
}

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  return new Request(new URL(req.url ?? '/', `http://127.0.0.1:${port}`), {
    method: req.method ?? 'GET',
    headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v] as [string, string]])),
    ...(body.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  })
}

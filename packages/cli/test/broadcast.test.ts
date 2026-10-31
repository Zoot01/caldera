import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterAll, expect, it } from 'vitest'
import { authorizeChannel, cloudflareSetup, generate, listBroadcasts, make, openProject, startDevBroadcastServer } from '../src/index.js'
import { workersIssues } from '../src/cloudflare.js'
import { calderaTools } from '../src/mcp/tools.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'broadcast-'
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
// The fixture with a database of two users and a post by user 1, and a free port for its realtime server.
const fresh = async () => {
  const dir = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/broadcast-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  const db = createClient({ url: `file:${join(dir, 'app.db')}` })
  await db.executeMultiple(`create table users (id integer primary key, name text not null);
    create table posts (id integer primary key, title text not null, author_id integer not null);
    insert into users values (1, 'Ann'), (2, 'Bob');
    insert into posts values (10, 'Hello', 1);`)
  db.close()
  writeFileSync(join(dir, '.env'), `DATABASE_URL=file:${join(dir, 'app.db')}\nBROADCAST_PORT=${await freePort()}\n`)
  writeFileSync(join(dir, 'AGENTS.md'), '# App\n\n<!-- caldera:generated:start -->\n<!-- caldera:generated:end -->\n')
  await generate(openProject(dir))
  return dir
}

it('generate lists channels for the server, their types for the browser, and types the hooks', async () => {
  const dir = await fresh()
  expect(readFileSync(join(dir, '.caldera/channels.gen.ts'), 'utf8')).toContain(
    "import * as channels0 from '../src/channels/posts.js'\n\nexport const channels = [channels0.PostChannel, channels0.RoomChannel] as const\n",
  )
  const client = readFileSync(join(dir, '.caldera/broadcast.client.gen.ts'), 'utf8')
  expect(client).toContain("import { registerChannels } from '@caldera/broadcast/client'")
  expect(client).toContain('registerChannels({\n  "posts.{post}": "private",\n  "rooms.{room}": "presence"\n})')
  // Types only, never imported at runtime: the browser bundle stays free of server code.
  expect(client).not.toContain('src/channels')
  const register = readFileSync(join(dir, '.caldera/register.d.ts'), 'utf8')
  expect(register).toContain("declare module '@caldera/broadcast' {")
  expect(register).toContain('"posts.{post}": typeof broadcast0.PostChannel')
  expect(register).toMatch(/"post.updated": typeof broadcast\d\.PostUpdated/)
  // Model broadcasting: the model's events, typed from its `with`.
  expect(register).toMatch(/"post.updated": import\('@caldera\/broadcast'\)\.ModelBroadcastEvent<typeof broadcast\d\.Post>/)
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  expect(agents).toContain('| `posts.{post}` | private | post |  | src/channels/posts.ts:')
  expect(agents).toContain('| `rooms.{room}` | presence |  | typing | src/channels/posts.ts:')
  expect(agents).toContain('| `post.updated` | `PostUpdated` | `with` | src/events/post-updated.ts |')

  expect((await listBroadcasts(openProject(dir))).events.map((e) => [e.as, e.export])).toEqual([['post.updated', 'PostUpdated'], ['post.updated', 'Post (model)']])
  expect((await listBroadcasts(openProject(dir))).channels[0]).toMatchObject({ pattern: 'posts.{post}', type: 'private', params: ['post'], bindings: { post: 'post' }, clientEvents: [] })
})

it('broadcast:authorize runs a channel’s authorize for a user, and explains a refusal', async () => {
  const dir = await fresh()
  expect(await authorizeChannel(openProject(dir), { channel: 'private-posts.10', userId: 1 })).toMatchObject({ allowed: true, pattern: 'posts.{post}', user: 1 })
  expect(await authorizeChannel(openProject(dir), { channel: 'private-posts.10', userId: 2 })).toMatchObject({ allowed: false, reason: 'denied' })
  expect(await authorizeChannel(openProject(dir), { channel: 'private-posts.99', userId: 1 })).toMatchObject({ allowed: false, reason: 'not_found' })
  expect(await authorizeChannel(openProject(dir), { channel: 'private-posts.10' })).toMatchObject({ allowed: false, reason: 'guest' })
  expect(await authorizeChannel(openProject(dir), { channel: 'presence-rooms.1', userId: 2 })).toMatchObject({ allowed: true, member: { user_id: '2', user_info: { id: 2, name: 'Bob' } } })
  await expect(authorizeChannel(openProject(dir), { channel: 'private-posts.10', userId: 7 })).rejects.toThrow(/No user 7/)
  // The same, as caldera mcp's tool.
  const tool = calderaTools({ root: dir, allowWrites: false }).find((t) => t.name === 'broadcast_authorize')!
  expect(await tool.handle({ channel: 'private-posts.10', userId: 2 })).toMatchObject({ allowed: false, reason: 'denied' })
})

it('caldera dev runs the realtime server the app publishes to, unless something already listens there', async () => {
  const dir = await fresh()
  const server = await startDevBroadcastServer(openProject(dir))
  expect(server).toBeDefined()
  try {
    expect(await (await fetch(`http://127.0.0.1:${server!.port}/`)).text()).toBe('OK')
    expect(await startDevBroadcastServer(openProject(dir))).toBeUndefined()
    // The app's own connection publishes to it (signed with the config's secret).
    const project = openProject(dir)
    const { app } = await project.load<{ app: { boot(o: unknown): Promise<void>; services: { broadcast: { send(on: string, e: string, d: unknown): Promise<void> } }; shutdown(): Promise<void> } }>('src/app.ts')
    await app.boot({ env: { DATABASE_URL: `file:${join(dir, 'app.db')}`, BROADCAST_PORT: String(server!.port) } })
    await app.services.broadcast.send('private-posts.10', 'post.updated', { title: 'x' })
    await app.shutdown()
  } finally {
    await server!.close()
  }
  // Without a secret in config, the dev server derives the app's (from APP_KEY), as the app does.
  writeFileSync(join(dir, 'src/config/broadcast.ts'), readFileSync(join(dir, 'src/config/broadcast.ts'), 'utf8').replace("secret: 'fixture-secret'", "appKey: 'k'.repeat(43)"))
  const { hubSettings } = await import('../src/index.js')
  const { deriveSecret } = await import('@caldera/broadcast')
  expect((await hubSettings(openProject(dir))).secret).toBe(await deriveSecret('k'.repeat(43)))
  writeFileSync(join(dir, '.env'), `DATABASE_URL=file:${join(dir, 'app.db')}\nBROADCAST_CONNECTION=log\n`)
  expect(await startDevBroadcastServer(openProject(dir))).toBeUndefined()
})

it('cloudflare:setup adds the BroadcastHub Durable Object, and check refuses a local realtime server on Workers', async () => {
  const dir = await fresh()
  await cloudflareSetup(openProject(dir))
  const wrangler = JSON.parse(readFileSync(join(dir, 'wrangler.json'), 'utf8'))
  expect(wrangler.durable_objects).toEqual({ bindings: [{ name: 'BROADCAST_HUB', class_name: 'BroadcastHub' }] })
  expect(wrangler.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['BroadcastHub'] }])
  expect(wrangler.vars.BROADCAST_CONNECTION).toBe('cloudflare')
  const worker = readFileSync(join(dir, 'src/worker.ts'), 'utf8')
  expect(worker).toContain("export { BroadcastHub } from '@caldera/broadcast/cloudflare'")
  expect(worker).toContain('const hub = broadcastHubRoute(request, env as never)')
  // The hub's app id and key are vars; its secret comes from APP_KEY, so no second secret to put.
  expect(wrangler.vars).toMatchObject({ BROADCAST_APP_ID: 'fixture-broadcast-app', BROADCAST_KEY: 'fixture-broadcast-app-key' })
  expect(readFileSync(join(dir, '.dev.vars.example'), 'utf8')).not.toContain('BROADCAST')
  const issues = await workersIssues(openProject(dir), async (env) => ({
    config: { broadcast: { default: env.BROADCAST_HUB ? 'server' : 'x', connections: { server: { driver: 'pusher', host: '127.0.0.1' } } } },
    shutdown: async () => {},
  }))
  expect(issues.map((i) => i.code)).toEqual(['workers_broadcast_local'])
})

it('make:channel writes a channel nobody may join yet, or one bound to its model and checked by its policy', async () => {
  const dir = await fresh()
  const project = openProject(dir)
  const read = (path: string) => readFileSync(join(dir, path), 'utf8')
  // No Order model: denies everyone, with how to open it up; --presence shows who's there.
  const orders = await make(project, 'channel', 'Order', { presence: true })
  expect(orders.created).toEqual(['src/channels/order.ts'])
  expect(orders.generate).toBe('ok')
  expect(read('src/channels/order.ts')).toContain(
    "export const OrderChannel = defineChannel('orders.{order}', {\n  type: 'presence',\n  authorize: () => false,\n  member: ({ user }) => ({ name: user.name }),\n})",
  )
  expect(read('src/channels/order.ts')).toContain("//   authorize: ({ gate, order }) => gate.can(Order, 'view', order),")
  expect(orders.hints[0]).toContain("const { members } = usePresence('orders.{order}', { order: order.id }")
  // A User model: bound, and its policy decides.
  await make(project, 'channel', 'User')
  expect(read('src/channels/user.ts')).toContain("import { User } from '../models/user.js'")
  expect(read('src/channels/user.ts')).toContain(
    "defineChannel('users.{user}', {\n  bind: { user: User },\n  authorize: ({ gate, user }) => gate.can(User, 'view', user),\n})",
  )
  expect(read('.caldera/broadcast.client.gen.ts')).toContain('"orders.{order}": "presence"')
})

it('make:event --channel writes an event browsers get on that channel, with a dotted name', async () => {
  const dir = await fresh()
  const project = openProject(dir)
  await make(project, 'channel', 'Order')
  const result = await make(project, 'event', 'OrderShipped', { channel: 'Order' })
  const source = readFileSync(join(dir, 'src/events/order-shipped.ts'), 'utf8')
  expect(source).toContain("import { OrderChannel } from '../channels/order.js'")
  expect(source).toContain("name: 'order.shipped',")
  expect(source).toContain('payload: z.object({ orderId: z.string() }),')
  expect(source).toContain('on: (p) => OrderChannel.with({ order: p.orderId }),')
  expect(result.generate).toBe('ok')
  // Without --channel: in-process only, and the hint says how to broadcast.
  const plain = await make(project, 'event', 'Ping')
  expect(readFileSync(join(dir, 'src/events/ping.ts'), 'utf8')).toContain("name: 'ping',")
  expect(plain.hints[0]).toContain('--channel <Channel>')
})

import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { createApp, defineEnv } from '@caldera-js/core'
import { createDatabase, setDefaultDatabase } from '@caldera-js/db'
import { createEvents, defineEvent, setDefaultEvents, type BroadcastPayload } from '@caldera-js/events'
import { createQueue, setDefaultQueue } from '@caldera-js/queue'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import PusherModule, { type Channel } from 'pusher-js'
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import { broadcastProvider, broadcastRoutes, channel, createBroadcaster, defineChannel, deriveSecret, hmacHex, setDefaultBroadcaster, signSubscription, type Broadcaster, type ModelBroadcastEvent, type PusherClientConfig } from '../src/index.js'
import { createHub, type HubConnection } from '../src/hub.js'
import { md5 } from '../src/md5.js'
import { serveBroadcast, startBroadcastServer } from '../src/server.js'
import { hasDocker, SOKETI_APP, startSoketi } from './soketi.js'
import { startWorkerdHub } from './workerd.js'
import { reverbDir, startReverb } from './reverb.js'
import { hasRedis, startRedis } from './redis-server.js'

// pusher-js is CommonJS whose types describe its ES build: the default import is the class at runtime.
const Pusher = PusherModule as unknown as typeof import('pusher-js').default

// A stand-in model: route-key lookups, as defineModel's findByRouteKey.
const posts = new Map([
  ['1', { id: '1', title: 'Hello', authorId: 'ann', secret: 'draft notes' }],
  ['2', { id: '2', title: 'Private', authorId: 'bob', secret: 'x' }],
])
const Post = { name: 'post', findByRouteKey: async (key: string) => posts.get(key) }

const PostChannel = defineChannel('posts.{post}', {
  bind: { post: Post },
  authorize: ({ user, post }) => post.authorId === user.id,
})
const RoomChannel = defineChannel('rooms.{roomId}', {
  type: 'presence',
  authorize: ({ params }) => params.roomId !== 'closed',
  member: ({ user }) => ({ id: user.id, name: `User ${user.id}` }),
  clientEvents: { typing: z.object({ at: z.number() }) },
})
const NewsChannel = defineChannel('news', { type: 'public' })

const PostUpdated = defineEvent({
  name: 'post.updated',
  payload: z.object({ postId: z.string(), title: z.string(), secret: z.string() }),
  broadcast: { on: (p) => PostChannel.with({ post: p.postId }), with: (p) => ({ postId: p.postId, title: p.title }) },
})
const Headline = defineEvent({ name: 'news.headline', payload: z.object({ text: z.string() }), broadcast: { on: () => [NewsChannel.with({})], as: 'headline' } })

function makeApp(connection: Record<string, unknown> = { driver: 'null' }) {
  const app = createApp({
    env: defineEnv({}),
    providers: [broadcastProvider(() => ({ default: 'main', connections: { main: connection as { driver: string } } }), { channels: [PostChannel, RoomChannel, NewsChannel] })],
  })
  const http = new Hono()
    .use(app.middleware())
    // The signed-in user, as the auth middleware would set it.
    .use(async (c, next) => {
      const id = c.req.header('x-user')
      c.set('user' as never, (id ? { id } : null) as never)
      await next()
    })
    .route('/', broadcastRoutes())
  return { app, http, broadcaster: () => (app.services as unknown as { broadcast: Broadcaster }).broadcast }
}

const auth = (http: { request: Hono['request'] }, channel: string, user?: string, socketId = '123.456') =>
  http.request('/_caldera/broadcast/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(user ? { 'x-user': user } : {}) },
    body: new URLSearchParams({ socket_id: socketId, channel_name: channel }).toString(),
  })

describe('channels', () => {
  it('names, matches and refuses what a channel name cannot hold', () => {
    expect(PostChannel.name({ post: 42 })).toBe('private-posts.42')
    expect(PostChannel.with({ post: 'a_b' })).toEqual({ kind: 'caldera.channel-ref', pattern: 'posts.{post}', name: 'private-posts.a_b' })
    expect(RoomChannel.name({ roomId: 'r1' })).toBe('presence-rooms.r1')
    expect(NewsChannel.name({})).toBe('news')
    expect(PostChannel.match('private-posts.42')).toEqual({ post: '42' })
    expect(PostChannel.match('presence-posts.42')).toBeNull()
    expect(PostChannel.match('private-posts.4.2')).toBeNull()
    expect(() => PostChannel.name({ post: 'a.b' })).toThrow(/can't contain/)
    expect(() => PostChannel.name({ post: 'a b' })).toThrow(/can't contain/)
    expect(() => defineChannel('private-x', { authorize: () => true })).toThrow(/prefix/)
    expect(() => defineChannel('x.{id}' as string, {} as never)).toThrow(/needs `authorize`/)
    expect(() => defineChannel('x.{id}', { authorize: () => true, bind: { post: Post } } as never)).toThrow(/no \{post\}/)
    expect(() => defineChannel('x', { type: 'public', authorize: () => true } as never)).toThrow(/public/)
    expect(PostChannel.source?.file).toContain('broadcast.test.ts')
  })

  it('types the authorize context from the pattern and bindings', () => {
    defineChannel('teams.{teamId}.posts.{post}', {
      bind: { post: Post },
      authorize: (ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<{ readonly teamId: string; readonly post: string }>()
        expectTypeOf(ctx.post.title).toBeString()
        return true
      },
    })
    expectTypeOf<BroadcastPayload<typeof PostUpdated>>().toEqualTypeOf<{ postId: string; title: string }>()
    expectTypeOf<BroadcastPayload<typeof Headline>>().toEqualTypeOf<{ text: string }>()
    // @ts-expect-error a param the pattern doesn't have
    const wrong = () => PostChannel.with({ id: 1 })
    expect(wrong).toThrow(/needs \{post\}/)
  })

  it('computes Pusher’s body_md5 like node:crypto', () => {
    for (const text of ['', 'abc', 'x'.repeat(56), 'héllo 🌍'.repeat(50)]) expect(md5(text)).toBe(createHash('md5').update(text).digest('hex'))
  })
})

describe('the auth route', () => {
  it('signs allowed subscriptions and refuses the rest without saying why', async () => {
    const { app, http } = makeApp({ driver: 'pusher', host: '127.0.0.1', port: 1, ...SOKETI_APP })
    await app.boot()
    const allowed = await auth(http, 'private-posts.1', 'ann')
    expect(allowed.status).toBe(200)
    const expected = createHash('sha256').update('') && (await import('node:crypto')).createHmac('sha256', SOKETI_APP.secret).update('123.456:private-posts.1').digest('hex')
    expect(await allowed.json()).toEqual({ auth: `${SOKETI_APP.key}:${expected}` })

    const presence = (await (await auth(http, 'presence-rooms.r1', 'ann')).json()) as { auth: string; channel_data: string }
    expect(JSON.parse(presence.channel_data)).toEqual({ user_id: 'ann', user_info: { id: 'ann', name: 'User ann' } })

    expect((await auth(http, 'private-posts.2', 'ann')).status).toBe(403) // not hers
    expect((await auth(http, 'private-posts.404', 'ann')).status).toBe(403) // no such post
    expect((await auth(http, 'private-nothing', 'ann')).status).toBe(403) // no such channel
    expect((await auth(http, 'presence-rooms.closed', 'ann')).status).toBe(403)
    expect((await auth(http, 'private-posts.1')).status).toBe(401) // signed out
    const bad = await auth(http, 'private-posts.1', 'ann', 'not-a-socket')
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad_request')
  })

  it('explains each decision, for caldera mcp', async () => {
    const broadcaster = createBroadcaster({ default: 'n', connections: { n: { driver: 'null' } } }, { channels: [PostChannel] })
    expect(await broadcaster.authorize({ channel: 'private-posts.2', user: { id: 'ann' } })).toMatchObject({ allowed: false, reason: 'denied', pattern: 'posts.{post}' })
    expect(await broadcaster.authorize({ channel: 'private-posts.9', user: { id: 'ann' } })).toMatchObject({ allowed: false, reason: 'not_found' })
    expect(await broadcaster.authorize({ channel: 'private-posts.1', user: null })).toMatchObject({ allowed: false, status: 401, reason: 'guest' })
    expect(await broadcaster.authorize({ channel: 'private-posts.1', user: { id: 'ann' } })).toMatchObject({ allowed: true, type: 'private' })
  })

  it('refuses at boot channels the driver can’t carry', () => {
    const limited = { kind: 'caldera.driver' as const, name: 'limited', capabilities: { presence: false, clientEvents: false, maxPayloadBytes: null }, create: () => ({}) as never }
    expect(() => createBroadcaster({ default: 'l', connections: { l: { driver: 'limited' } } }, { channels: [RoomChannel], drivers: [limited] })).toThrow(/presence channel/)
  })
})

describe('broadcast events', () => {
  let broadcaster: Broadcaster
  beforeAll(() => {
    broadcaster = createBroadcaster({ default: 'n', connections: { n: { driver: 'null' } } }, { channels: [PostChannel, NewsChannel] }) as never
    setDefaultBroadcaster(broadcaster)
  })
  afterAll(() => setDefaultBroadcaster(undefined))

  it('sends `with`, not the whole payload, on the event’s channels', async () => {
    const fake = broadcaster.fake()
    const events = createEvents()
    await events.emit(PostUpdated, { postId: '1', title: 'New title', secret: 'never sent' })
    await events.emit(Headline, { text: 'Hi' })
    expect(fake.sent()).toEqual([
      { event: 'post.updated', channels: ['private-posts.1'], data: { postId: '1', title: 'New title' }, socketId: undefined },
      { event: 'headline', channels: ['news'], data: { text: 'Hi' }, socketId: undefined },
    ])
    fake.assertBroadcast(PostUpdated, { on: PostChannel.with({ post: '1' }), data: (d) => d.title === 'New title' })
    expect(() => fake.assertBroadcast(PostUpdated, { on: 'private-posts.2' })).toThrow(/Expected "post.updated" to be broadcast on private-posts.2/)
    fake.restore()
  })

  it('broadcasts only once the transaction commits, and not on rollback', async () => {
    const client = new PGlite()
    const db = createDatabase(drizzle({ client }), { driver: 'postgres' })
    setDefaultDatabase(() => db)
    const fake = broadcaster.fake()
    try {
      const events = createEvents()
      await db.transaction(async () => {
        await events.emit(PostUpdated, { postId: '1', title: 'Committed', secret: '' })
        fake.assertNothingBroadcast()
      })
      fake.assertBroadcast(PostUpdated)
      await db
        .transaction(async () => {
          await events.emit(PostUpdated, { postId: '1', title: 'Rolled back', secret: '' })
          throw new Error('rollback')
        })
        .catch(() => {})
      expect(fake.sent().map((s) => (s.data as { title: string }).title)).toEqual(['Committed'])
    } finally {
      fake.restore()
      setDefaultDatabase(undefined)
      await client.close()
    }
  })

  it('refuses an oversized payload where it is emitted', async () => {
    const small = createBroadcaster({ default: 'p', connections: { p: { driver: 'pusher', cluster: 'eu', ...SOKETI_APP } } })
    await expect(small.send('news', 'big', { text: 'x'.repeat(11_000) })).rejects.toThrow(/at most 10240/)
  })

  it('needs a broadcaster, and says so', async () => {
    setDefaultBroadcaster(undefined)
    await expect(createEvents().emit(Headline, { text: 'x' })).rejects.toThrow(/broadcastProvider/)
    setDefaultBroadcaster(broadcaster)
  })

  it('with queue: true, sends from a job', async () => {
    const Queued = defineEvent({ name: 'queued', payload: z.object({ n: z.number() }), broadcast: { on: () => NewsChannel.with({}), queue: true } })
    const queue = createQueue({ default: 'sync', connections: { sync: { driver: 'sync' } } })
    const local = createBroadcaster({ default: 'n', connections: { n: { driver: 'null' } } }, { queue: () => queue as never })
    queue.register(local.job as never)
    const fake = local.fake()
    await local.broadcast(Queued, { n: 1 })
    expect(fake.sent()).toEqual([{ event: 'queued', channels: ['news'], data: { n: 1 }, socketId: undefined }])
  })
})

// Real pusher-protocol servers, and the real pusher-js client: Soketi (in Docker) as the reference,
// and Caldera's own hub on Node (`caldera broadcast:serve`), which must behave the same.
const servers = [
  ...(hasDocker ? [{ name: 'Soketi', start: startSoketi }] : []),
  {
    name: 'caldera broadcast:serve',
    start: async () => {
      const server = await startBroadcastServer({ ...SOKETI_APP, port: 0 })
      return { host: '127.0.0.1', port: server.port, stop: server.close }
    },
  },
  // On workerd, publishes from elsewhere reach the Durable Object through broadcastHubRoute.
  { name: 'the Durable Object hub (workerd)', start: startWorkerdHub },
  // Laravel Reverb, when a Laravel app with it is at CALDERA_REVERB_DIR.
  ...(reverbDir ? [{ name: 'Laravel Reverb', start: startReverb }] : []),
]

describe.each(servers)('over $name', { timeout: 30_000 }, ({ start }) => {
  let soketi: Awaited<ReturnType<typeof startSoketi>>
  let setup: ReturnType<typeof makeApp>
  const clients: InstanceType<typeof Pusher>[] = []
  beforeAll(async () => {
    soketi = await start()
    setup = makeApp({ driver: 'pusher', host: soketi.host, port: soketi.port, ...SOKETI_APP })
    await setup.app.boot()
    setDefaultBroadcaster(setup.broadcaster())
    setDefaultEvents(undefined)
  }, 120_000)
  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect()
  })
  afterAll(async () => {
    setDefaultBroadcaster(undefined)
    await soketi?.stop()
  })

  // A browser: pusher-js, configured from the driver's client(), authorizing through the app's route.
  const connect = async (user: string) => {
    const config = setup.broadcaster().client() as PusherClientConfig
    const client = new Pusher(config.key, {
      ...config,
      cluster: config.cluster ?? '',
      channelAuthorization: {
        endpoint: '',
        transport: 'ajax',
        customHandler: async ({ socketId, channelName }, callback) => {
          const res = await auth(setup.http, channelName, user, socketId)
          if (res.ok) callback(null, (await res.json()) as never)
          else callback(new Error(`auth ${res.status}`), null)
        },
      },
    })
    clients.push(client)
    await new Promise<void>((resolve) => client.connection.bind('connected', () => resolve()))
    return client
  }
  const subscribed = (channel: Channel) =>
    new Promise<unknown>((resolve, reject) => {
      channel.bind('pusher:subscription_succeeded', resolve)
      channel.bind('pusher:subscription_error', reject)
    })
  const next = (channel: Channel, event: string) => new Promise<unknown>((resolve) => channel.bind(event, resolve))

  it('delivers an emitted event to an authorized subscriber, and only `with`', async () => {
    const ann = await connect('ann')
    const channel = ann.subscribe('private-posts.1')
    await subscribed(channel)
    const received = next(channel, 'post.updated')
    await createEvents().emit(PostUpdated, { postId: '1', title: 'Live', secret: 'never sent' })
    await setup.broadcaster().flush()
    expect(await received).toEqual({ postId: '1', title: 'Live' })
  })

  it('refuses a subscription the channel doesn’t allow', async () => {
    const bob = await connect('bob')
    await expect(subscribed(bob.subscribe('private-posts.1'))).rejects.toMatchObject({ type: 'AuthError', error: 'auth 403' })
  })

  it('skips the sender with toOthers', async () => {
    const [one, two] = [await connect('ann'), await connect('ann')]
    const [a, b] = [one.subscribe('private-posts.1'), two.subscribe('private-posts.1')]
    await Promise.all([subscribed(a), subscribed(b)])
    const got: string[] = []
    a.bind('post.updated', () => got.push('one'))
    const second = next(b, 'post.updated')
    // As if the first browser made the request (pusher-js's socket id in X-Socket-ID).
    await setup.broadcaster().send(PostChannel.with({ post: '1' }), 'post.updated', { postId: '1', title: 't' }, { except: one.connection.socket_id })
    await second
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(got).toEqual([])
  })

  it('shows presence members with their info, and relays whispers', async () => {
    const ann = await connect('ann')
    const room = ann.subscribe('presence-rooms.r1') as Channel & { members: { count: number; each(cb: (m: { id: string; info: unknown }) => void): void } }
    await subscribed(room)
    const joined = next(room, 'pusher:member_added')
    const bob = await connect('bob')
    const bobRoom = bob.subscribe('presence-rooms.r1')
    await subscribed(bobRoom)
    expect(await joined).toEqual({ id: 'bob', info: { id: 'bob', name: 'User bob' } })
    expect(room.members.count).toBe(2)
    const whisper = next(room, 'client-typing')
    ;(bobRoom as unknown as { trigger(event: string, data: unknown): boolean }).trigger('client-typing', { at: 1 })
    expect(await whisper).toEqual({ at: 1 })
  })

  it('announces a member once per user, and when their last tab leaves', async () => {
    const watcher = await connect('carol')
    const room = watcher.subscribe('presence-rooms.r2')
    await subscribed(room)
    const events: string[] = []
    room.bind('pusher:member_added', (m: { id: string }) => events.push(`+${m.id}`))
    room.bind('pusher:member_removed', (m: { id: string }) => events.push(`-${m.id}`))
    const [tab1, tab2] = [await connect('dan'), await connect('dan')]
    await subscribed(tab1.subscribe('presence-rooms.r2'))
    await subscribed(tab2.subscribe('presence-rooms.r2'))
    tab1.unsubscribe('presence-rooms.r2')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(events).toEqual(['+dan'])
    tab2.disconnect()
    await vi.waitFor(() => expect(events).toEqual(['+dan', '-dan']))
  })

  it('refuses a publish with a bad signature', async () => {
    const forged = createBroadcaster({ default: 'p', connections: { p: { driver: 'pusher', host: soketi.host, port: soketi.port, ...SOKETI_APP, secret: 'wrong' } } })
    await expect(forged.send('news', 'x', {})).rejects.toThrow(/refused the broadcast \(401\)/)
  })
})

describe('the hub', () => {
  it('keeps no state of its own, so a Durable Object woken from hibernation carries on', async () => {
    const inbox = new Map<string, string[]>()
    const connections = new Set<HubConnection>()
    const make = (socketId: string): HubConnection => {
      inbox.set(socketId, [])
      return { state: { socketId, channels: {} }, send: (m) => inbox.get(socketId)!.push(m), close: () => {}, save: () => {} }
    }
    const options = { ...SOKETI_APP, connections: () => connections }
    const before = createHub(options)
    const [ann, bob] = [make('1.1'), make('2.2')]
    connections.add(ann).add(bob)
    for (const [connection, user] of [[ann, 'ann'], [bob, 'bob']] as const) {
      const channelData = JSON.stringify({ user_id: user, user_info: { name: user } })
      const { auth } = await signSubscription(SOKETI_APP.key, SOKETI_APP.secret, connection.state.socketId, 'presence-rooms.1', channelData)
      await before.receive(connection, JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-rooms.1', auth, channel_data: channelData } }))
    }
    // Evicted: a new hub, the same sockets (their attachments).
    const after = createHub(options)
    connections.delete(ann)
    await after.close(ann)
    expect(JSON.parse(inbox.get('2.2')!.at(-1)!)).toEqual({ event: 'pusher_internal:member_removed', channel: 'presence-rooms.1', data: '{"user_id":"ann"}' })
  })

  it('refuses a forged subscription, and client events where they aren’t allowed', async () => {
    const sent: string[] = []
    const connection: HubConnection = { state: { socketId: '1.1', channels: {} }, send: (m) => sent.push(m), close: () => {}, save: () => {} }
    const hub = createHub({ ...SOKETI_APP, connections: () => [connection] })
    await hub.receive(connection, JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-posts.1', auth: `${SOKETI_APP.key}:forged` } }))
    expect(JSON.parse(sent.pop()!)).toMatchObject({ event: 'pusher:subscription_error', channel: 'private-posts.1', data: { type: 'AuthError', status: 401 } })
    await hub.receive(connection, JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'news' } }))
    await hub.receive(connection, JSON.stringify({ event: 'client-typing', channel: 'news', data: {} }))
    expect(JSON.parse(sent.pop()!)).toMatchObject({ event: 'pusher:error' })
    expect(connection.state.channels).toEqual({ news: null })
  })

  it('on Workers, publishes through the binding and points browsers at the app’s origin', async () => {
    const worker = await startWorkerdHub()
    const client = new Pusher(SOKETI_APP.key, { cluster: '', wsHost: worker.host, wsPort: worker.port, forceTLS: false, enabledTransports: ['ws'] })
    try {
      const channel = client.subscribe('news')
      await new Promise((resolve) => channel.bind('pusher:subscription_succeeded', resolve))
      const received = new Promise((resolve) => channel.bind('headline', resolve))
      const res = await fetch(new URL('/publish', worker.url), { method: 'POST', body: JSON.stringify({ channels: ['news'], event: 'headline', data: '{"text":"From the Worker"}' }) })
      expect(await res.json()).toEqual({ ok: true, client: { key: SOKETI_APP.key, cluster: '', wsHost: '127.0.0.1', wsPort: worker.port, forceTLS: false, enabledTransports: ['ws', 'wss'] } })
      expect(await received).toEqual({ text: 'From the Worker' })
    } finally {
      client.disconnect()
      await worker.stop()
    }
  }, 30_000)
})

describe('the browser client', () => {
  it('joins once per channel, hears events, whispers, lists members, and sends X-Socket-ID', async () => {
    const hub = await startBroadcastServer({ ...SOKETI_APP, port: 0 })
    const setup = makeApp({ driver: 'pusher', host: '127.0.0.1', port: hub.port, ...SOKETI_APP })
    await setup.app.boot()
    // The app over HTTP, as the browser reaches it; the user comes from a header this test sets.
    let user = 'ann'
    const site = serve({ fetch: (request) => {
      const headers = new Headers(request.headers)
      headers.set('x-user', user)
      return setup.http.fetch(new Request(request, { headers }))
    }, port: 0 })
    await new Promise((resolve) => site.once('listening', resolve))
    const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`
    const client = await import('../src/client.js')
    try {
      client.registerChannels({ 'posts.{post}': 'private', 'rooms.{roomId}': 'presence', news: 'public' })
      expect(client.channelName('posts.{post}', { post: 1 })).toBe('private-posts.1')
      expect(() => client.channelName('nope')).toThrow(/No channel "nope"/)
      // Inertia's first `navigate` comes after the first render: hooks mounted before the config learn of it.
      const told: number[] = []
      const stop = client.onConfigured(() => told.push(client.configVersion()))
      expect(client.subscribe('news')).toBeUndefined()
      const before = client.configVersion()
      client.configureBroadcast({ ...(setup.broadcaster().client() as PusherClientConfig), authEndpoint: `${siteUrl}/_caldera/broadcast/auth` })
      client.configureBroadcast({ ...(setup.broadcaster().client() as PusherClientConfig), authEndpoint: `${siteUrl}/_caldera/broadcast/auth` }) // the same: no change
      expect(told).toEqual([before + 1])
      stop()

      const first = client.subscribe('posts.{post}', { post: 1 })!
      const second = client.subscribe('posts.{post}', { post: 1 })!
      expect(client.connection()!.allChannels().map((c) => c.name)).toEqual(['private-posts.1']) // one subscription for both
      await new Promise((resolve) => first.listen('pusher:subscription_succeeded', resolve))
      const heard = new Promise((resolve) => second.listen('post.updated', resolve))
      await setup.broadcaster().send(PostChannel.with({ post: '1' }), 'post.updated', { title: 'Hi' })
      expect(await heard).toEqual({ title: 'Hi' })
      expect(client.withSocketId({ headers: { accept: 'x' } }).headers).toEqual({ accept: 'x', 'X-Socket-ID': client.socketId() })
      first.leave()
      expect(client.connection()!.channel('private-posts.1')).toBeDefined() // still used by `second`
      second.leave()
      expect(client.connection()!.channel('private-posts.1')).toBeUndefined()

      const room = client.subscribe('rooms.{roomId}', { roomId: 'r9' })!
      await new Promise((resolve) => room.listen('pusher:subscription_succeeded', resolve))
      expect(client.membersOf(room)).toEqual([{ id: 'ann', info: { id: 'ann', name: 'User ann' } }])
      // Another user's browser, whispering.
      user = 'bob'
      const other = new Pusher(SOKETI_APP.key, { ...(setup.broadcaster().client() as PusherClientConfig), cluster: '', channelAuthorization: { endpoint: `${siteUrl}/_caldera/broadcast/auth`, transport: 'ajax' } })
      const whispered = new Promise((resolve) => room.listen('client-typing', (data, meta) => resolve({ data, meta })))
      const otherRoom = other.subscribe('presence-rooms.r9')
      await new Promise((resolve) => otherRoom.bind('pusher:subscription_succeeded', resolve))
      otherRoom.trigger('client-typing', { at: 5 })
      expect(await whispered).toEqual({ data: { at: 5 }, meta: { user_id: 'bob' } })
      other.disconnect()
    } finally {
      client.configureBroadcast(null)
      site.close()
      await hub.close()
    }
  }, 30_000)
})

describe('serveBroadcast', () => {
  it('starts the server an app’s own connection points at, with the secret derived from APP_KEY', async () => {
    const appKey = 'app-key-0123456789-0123456789-01234'
    const app = { config: { broadcast: { default: 'server', connections: { server: { driver: 'pusher', host: '127.0.0.1', port: 0, appId: 'app', key: 'key', appKey }, log: { driver: 'log' } } } } }
    const server = await serveBroadcast(app)
    try {
      expect(await (await fetch(`http://127.0.0.1:${server!.port}/up`)).text()).toBe('OK')
      // The app's side signs its HTTP API calls with the same derived secret.
      const secret = await deriveSecret(appKey)
      const body = JSON.stringify({ name: 'x', channels: ['public'], data: '{}' })
      const query = `auth_key=key&auth_timestamp=${Math.floor(Date.now() / 1000)}&auth_version=1.0&body_md5=${md5(body)}`
      const signature = await hmacHex(secret, `POST\n/apps/app/events\n${query}`)
      expect((await fetch(`http://127.0.0.1:${server!.port}/apps/app/events?${query}&auth_signature=${signature}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status).toBe(200)
    } finally {
      await server?.close()
    }
    // Nothing to run for log (or hosted Pusher, without a host).
    expect(await serveBroadcast(app, { connection: 'log' })).toBeUndefined()
  })
})

describe('the shared secret', () => {
  it('is derived from APP_KEY when not set, the same way by the app and the hub', async () => {
    const appKey = 'k'.repeat(43)
    const hub = await startBroadcastServer({ appId: 'a', key: 'k', secret: deriveSecret(appKey), port: 0 })
    try {
      const app = createBroadcaster({ default: 's', connections: { s: { driver: 'pusher', appId: 'a', key: 'k', appKey, host: '127.0.0.1', port: hub.port } } })
      await app.send('news', 'x', {})
      const other = createBroadcaster({ default: 's', connections: { s: { driver: 'pusher', appId: 'a', key: 'k', appKey: 'z'.repeat(43), host: '127.0.0.1', port: hub.port } } })
      await expect(other.send('news', 'x', {})).rejects.toThrow(/\(401\)/)
    } finally {
      await hub.close()
    }
    expect(await deriveSecret(appKey)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('must be given for hosted Pusher, and for a server without APP_KEY', () => {
    expect(() => createBroadcaster({ default: 'p', connections: { p: { driver: 'pusher', appId: 'a', key: 'k', cluster: 'eu', appKey: 'x'.repeat(40) } } }).manager.use()).toThrow(/PUSHER_SECRET/)
    expect(() => createBroadcaster({ default: 's', connections: { s: { driver: 'pusher', appId: 'a', key: 'k', host: 'h' } } }).manager.use()).toThrow(/needs `secret`, or `appKey`/)
  })
})

describe('model broadcasting', () => {
  it('sends created, updated, deleted and restored after commit, with only `with`, and nothing on rollback', async () => {
    const { pgTable, serial, text, timestamp } = await import('drizzle-orm/pg-core')
    const { defineRelations } = await import('drizzle-orm')
    const { defineModel } = await import('@caldera-js/db')
    const notes = pgTable('notes', { id: serial().primaryKey(), title: text().notNull(), secret: text().notNull().default(''), deletedAt: timestamp('deleted_at') })
    const NoteChannel = defineChannel('notes.{note}', { authorize: () => true })
    const Typed = defineModel(notes, {
      name: 'note',
      softDeletes: 'deletedAt',
      broadcast: { on: (note) => NoteChannel.with({ note: note.id }), with: (note) => ({ id: note.id, title: note.title }) },
    })
    expectTypeOf<BroadcastPayload<ModelBroadcastEvent<typeof Typed>>>().toEqualTypeOf<{ id: number; title: string }>()
    // This package registers no schema, so model inputs aren't typed here (an app's are).
    const Note = Typed as any
    expect(Note.describe().broadcast).toEqual(['note.created', 'note.updated', 'note.deleted'])

    const client = new PGlite()
    await client.exec('create table notes (id serial primary key, title text not null, secret text not null default \'\', deleted_at timestamp)')
    const db = createDatabase(drizzle({ client, relations: defineRelations({ notes }, () => ({})) }), { driver: 'postgres' })
    setDefaultDatabase(() => db)
    const broadcaster = createBroadcaster({ default: 'n', connections: { n: { driver: 'null' } } }, { channels: [NoteChannel] })
    setDefaultBroadcaster(broadcaster)
    const fake = broadcaster.fake()
    try {
      let id = 0
      await db.transaction(async () => {
        id = (await Note.create({ title: 'One', secret: 'hush' })).id
        fake.assertNothingBroadcast()
      })
      await Note.update(id, { title: 'Two' })
      await Note.delete(id)
      await Note.restore(id)
      await db.transaction(async () => {
        await Note.create({ title: 'Rolled back' })
        throw new Error('rollback')
      }).catch(() => {})
      expect(fake.sent().map((s) => [s.event, s.channels[0], s.data])).toEqual([
        ['note.created', `private-notes.${id}`, { id, title: 'One' }],
        ['note.updated', `private-notes.${id}`, { id, title: 'Two' }],
        ['note.deleted', `private-notes.${id}`, { id, title: 'Two' }],
        ['note.updated', `private-notes.${id}`, { id, title: 'Two' }],
      ])
      // Checked inside the write: an oversized payload fails it (and its transaction).
      const Big = defineModel(notes, { name: 'big', broadcast: { on: (n) => NoteChannel.with({ note: n.id }), with: (n) => ({ blob: n.title.repeat(2000) }) } }) as any
      fake.restore()
      const strict = createBroadcaster({ default: 'p', connections: { p: { driver: 'pusher', cluster: 'eu', appId: 'a', key: 'k', secret: 's' } } })
      setDefaultBroadcaster(strict)
      await expect(Big.create({ title: 'xxxxxxxx' })).rejects.toThrow(/at most 10240/)
      expect(await Note.findMany({ where: { title: 'xxxxxxxx' } })).toEqual([])
      // Without broadcastProvider, a broadcasting model says what's missing.
      setDefaultBroadcaster(undefined)
      await expect(Note.create({ title: 'x' })).rejects.toThrow(/broadcastProvider/)
    } finally {
      fake.restore()
      setDefaultBroadcaster(undefined)
      setDefaultDatabase(undefined)
      await client.close()
    }
  })
})

it('channel() names a registered channel by pattern, resolved when sent', async () => {
  const broadcaster = createBroadcaster({ default: 'n', connections: { n: { driver: 'null' } } }, { channels: [PostChannel] })
  setDefaultBroadcaster(broadcaster)
  const fake = broadcaster.fake()
  try {
    const ref = channel('posts.{post}' as never, { post: 7 } as never)
    expect(ref.pattern).toBe('posts.{post}')
    await broadcaster.send(ref, 'post.updated', {})
    expect(fake.sent()[0]!.channels).toEqual(['private-posts.7'])
    await expect(broadcaster.send(channel('nope' as never, {} as never), 'x', {})).rejects.toThrow(/No channel "nope"/)
  } finally {
    fake.restore()
    setDefaultBroadcaster(undefined)
  }
})

// Several hubs as one, over a real Redis: what `caldera broadcast:serve` does with REDIS_URL.
describe.runIf(hasRedis)('several hubs over Redis', { timeout: 30_000 }, () => {
  let redis: Awaited<ReturnType<typeof startRedis>>
  const servers: { port: number; close(): Promise<void> }[] = []
  const clients: InstanceType<typeof Pusher>[] = []
  beforeAll(async () => {
    redis = await startRedis()
  })
  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect()
    for (const server of servers.splice(0)) await server.close()
  })
  afterAll(async () => {
    await redis?.stop()
  })
  const hub = async () => {
    const server = await startBroadcastServer({ ...SOKETI_APP, port: 0, redis: redis.url, nodeTtlSeconds: 1 })
    servers.push(server)
    return server
  }
  // A browser on one hub, signing its own subscriptions (the app's auth route is tested above).
  const browser = async (port: number, user: string) => {
    const client = new Pusher(SOKETI_APP.key, {
      cluster: '', wsHost: '127.0.0.1', wsPort: port, forceTLS: false, enabledTransports: ['ws'],
      channelAuthorization: {
        endpoint: '', transport: 'ajax',
        customHandler: async ({ socketId, channelName }, callback) => {
          const data = channelName.startsWith('presence-') ? JSON.stringify({ user_id: user, user_info: { name: user } }) : undefined
          callback(null, (await signSubscription(SOKETI_APP.key, SOKETI_APP.secret, socketId, channelName, data)) as never)
        },
      },
    })
    clients.push(client)
    return client
  }
  const joined = (channel: Channel) => new Promise<unknown>((resolve) => channel.bind('pusher:subscription_succeeded', resolve))

  it('delivers a publish to browsers on every hub, and whispers across them', async () => {
    const [one, two] = [await hub(), await hub()]
    const [a, b] = [(await browser(one.port, 'ann')).subscribe('private-posts.1'), (await browser(two.port, 'bob')).subscribe('private-posts.1')]
    await Promise.all([joined(a), joined(b)])
    const heard = Promise.all([new Promise((r) => a.bind('post.updated', r)), new Promise((r) => b.bind('post.updated', r))])
    // Published to the first hub only.
    await createBroadcaster({ default: 's', connections: { s: { driver: 'pusher', ...SOKETI_APP, host: '127.0.0.1', port: one.port } } }).send('private-posts.1', 'post.updated', { n: 1 })
    expect(await heard).toEqual([{ n: 1 }, { n: 1 }])
    const whispered = new Promise((r) => a.bind('client-typing', r))
    b.trigger('client-typing', { at: 1 })
    expect(await whispered).toEqual({ at: 1 })
  })

  it('shares presence: members on every hub, and leaving on one', async () => {
    const [one, two] = [await hub(), await hub()]
    const annRoom = (await browser(one.port, 'ann')).subscribe('presence-rooms.c') as Channel & { members: { count: number } }
    await joined(annRoom)
    const added = new Promise((r) => annRoom.bind('pusher:member_added', r))
    const bob = await browser(two.port, 'bob')
    const bobRoom = bob.subscribe('presence-rooms.c') as Channel & { members: { count: number } }
    await joined(bobRoom)
    expect(await added).toEqual({ id: 'bob', info: { name: 'bob' } })
    expect(bobRoom.members.count).toBe(2) // bob's hub knows ann, connected to the other one
    const removed = new Promise((r) => annRoom.bind('pusher:member_removed', r))
    bob.disconnect()
    expect(await removed).toEqual({ id: 'bob', info: { name: 'bob' } })
  })

  it('removes the members of a hub that died without a word, once its heartbeat expires', async () => {
    const one = await hub()
    const annRoom = (await browser(one.port, 'ann')).subscribe('presence-rooms.d')
    await joined(annRoom)
    // Another hub in its own process, killed outright.
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { startBroadcastServer } = await import(${JSON.stringify(new URL('../dist/server.js', import.meta.url).href)})
      const s = await startBroadcastServer({ appId: '${SOKETI_APP.appId}', key: '${SOKETI_APP.key}', secret: '${SOKETI_APP.secret}', port: 0, redis: '${redis.url}', nodeTtlSeconds: 1 })
      console.log(s.port)`], { stdio: ['ignore', 'pipe', 'inherit'] })
    const port = Number(await new Promise<string>((resolve) => child.stdout!.once('data', (chunk: Buffer) => resolve(chunk.toString()))))
    const added = new Promise((r) => annRoom.bind('pusher:member_added', r))
    await joined((await browser(port, 'carol')).subscribe('presence-rooms.d'))
    await added
    const removed = new Promise((r) => annRoom.bind('pusher:member_removed', r))
    child.kill('SIGKILL')
    expect(await removed).toEqual({ id: 'carol', info: { name: 'carol' } })
  })
})

// The sse driver: realtime from the app itself, read by the browser client over HTTP.
describe('the sse driver', { timeout: 30_000 }, () => {
  const sseApp = (connection: Record<string, unknown> = { driver: 'sse' }) => {
    const setup = makeApp(connection)
    // Without the presence channel: sse has no presence (checked at boot below).
    return setup
  }
  const serveApp = async (http: { fetch(request: Request): Response | Promise<Response> }, as: () => string, port = 0) => {
    const site = serve({ fetch: (request) => {
      const headers = new Headers(request.headers)
      headers.set('x-user', as())
      return http.fetch(new Request(request, { headers }))
    }, port })
    await new Promise((resolve) => site.once('listening', resolve))
    return { site: site as import('node:http').Server, url: `http://127.0.0.1:${(site.address() as { port: number }).port}` }
  }
  const sseOnly = (connection: Record<string, unknown>) => {
    const app = createApp({ env: defineEnv({}), providers: [broadcastProvider(() => ({ default: 'main', connections: { main: connection as { driver: string } } }), { channels: [PostChannel, NewsChannel] })] })
    const http = new Hono().use(app.middleware()).use(async (c, next) => {
      const id = c.req.header('x-user')
      c.set('user' as never, (id ? { id } : null) as never)
      await next()
    }).route('/', broadcastRoutes())
    return { app, http, broadcaster: () => (app.services as unknown as { broadcast: Broadcaster }).broadcast }
  }
  const client = () => import('../src/client.js')
  afterEach(async () => (await client()).configureBroadcast(null))

  it('refuses presence channels at boot', async () => {
    const { app } = sseApp()
    await expect(app.boot()).rejects.toThrow(/presence channel/)
  })

  it('streams public and authorized private channels, refuses the rest, and skips the sender', async () => {
    const setup = sseOnly({ driver: 'sse' })
    await setup.app.boot()
    let user = 'ann'
    const { site, url } = await serveApp(setup.http, () => user)
    const browser = await client()
    try {
      browser.registerChannels({ news: 'public', 'posts.{post}': 'private' })
      expect(setup.broadcaster().client()).toEqual({ transport: 'sse', url: '/_caldera/broadcast/sse' })
      browser.configureBroadcast({ transport: 'sse', url: `${url}/_caldera/broadcast/sse` })
      const news = browser.subscribe('news')!
      const post = browser.subscribe('posts.{post}', { post: 1 })!
      await Promise.all([new Promise((r) => news.listen('pusher:subscription_succeeded', r)), new Promise((r) => post.listen('pusher:subscription_succeeded', r))])
      expect(browser.socketId()).toMatch(/^\d+\.\d+$/)
      const heard = Promise.all([new Promise((r) => news.listen('headline', r)), new Promise((r) => post.listen('post.updated', r))])
      await setup.broadcaster().send('news', 'headline', { text: 'Hi' })
      await setup.broadcaster().send(PostChannel.with({ post: 1 }), 'post.updated', { title: 'T' })
      expect(await heard).toEqual([{ text: 'Hi' }, { title: 'T' }])
      // toOthers: this stream's id is its X-Socket-ID.
      const got: unknown[] = []
      news.listen('headline', (d) => got.push(d))
      await setup.broadcaster().send('news', 'headline', { text: 'not me' }, { except: browser.socketId()! })
      await new Promise((r) => setTimeout(r, 300))
      expect(got).toEqual([])
      // Bob may not join ann's post.
      user = 'bob'
      const refused = await fetch(`${url}/_caldera/broadcast/sse/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: browser.socketId(), channel: 'private-posts.1' }) })
      expect(refused.status).toBe(403)
      const unknownStream = await fetch(`${url}/_caldera/broadcast/sse/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: '1.1', channel: 'news' }) })
      expect(unknownStream.status).toBe(404)
    } finally {
      browser.configureBroadcast(null)
      site.closeAllConnections()
      site.close()
    }
  })

  it('reconnects after the stream drops, and joins its channels again', async () => {
    const setup = sseOnly({ driver: 'sse' })
    await setup.app.boot()
    const first = await serveApp(setup.http, () => 'ann')
    const port = Number(new URL(first.url).port)
    const browser = await client()
    browser.registerChannels({ news: 'public' })
    browser.configureBroadcast({ transport: 'sse', url: `${first.url}/_caldera/broadcast/sse` })
    const news = browser.subscribe('news')!
    await new Promise((r) => news.listen('pusher:subscription_succeeded', r))
    // The server goes away (a deploy), and comes back on the same port.
    first.site.closeAllConnections()
    await new Promise((r) => first.site.close(r))
    const second = await serveApp(setup.http, () => 'ann', port)
    try {
      await new Promise((r) => news.listen('pusher:subscription_succeeded', r))
      const heard = new Promise((r) => news.listen('headline', r))
      await setup.broadcaster().send('news', 'headline', { text: 'back' })
      expect(await heard).toEqual({ text: 'back' })
    } finally {
      browser.configureBroadcast(null)
      second.site.closeAllConnections()
      second.site.close()
    }
  })

  it.runIf(hasRedis)('shares broadcasts between app processes over Redis', async () => {
    const redis = await startRedis()
    const [one, two] = [sseOnly({ driver: 'sse', redis: redis.url }), sseOnly({ driver: 'sse', redis: redis.url })]
    await one.app.boot()
    await two.app.boot()
    const site = await serveApp(two.http, () => 'ann')
    const browser = await client()
    try {
      browser.registerChannels({ news: 'public' })
      browser.configureBroadcast({ transport: 'sse', url: `${site.url}/_caldera/broadcast/sse` })
      const news = browser.subscribe('news')!
      await new Promise((r) => news.listen('pusher:subscription_succeeded', r))
      await new Promise((r) => setTimeout(r, 200)) // both processes subscribed to Redis
      const heard = new Promise((r) => news.listen('headline', r))
      // Published by the other process, which holds no stream.
      await one.broadcaster().send('news', 'headline', { text: 'from one' })
      expect(await heard).toEqual({ text: 'from one' })
    } finally {
      browser.configureBroadcast(null)
      site.site.closeAllConnections()
      site.site.close()
      await one.app.shutdown()
      await two.app.shutdown()
      await redis.stop()
    }
  })
})

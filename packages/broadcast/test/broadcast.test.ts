import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { createApp, defineEnv } from '@caldera/core'
import { createDatabase, setDefaultDatabase } from '@caldera/db'
import { createEvents, defineEvent, setDefaultEvents, type BroadcastPayload } from '@caldera/events'
import { createQueue, setDefaultQueue } from '@caldera/queue'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import PusherModule, { type Channel } from 'pusher-js'
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import { broadcastProvider, broadcastRoutes, createBroadcaster, defineChannel, setDefaultBroadcaster, signSubscription, type Broadcaster } from '../src/index.js'
import { createHub, type HubConnection } from '../src/hub.js'
import { md5 } from '../src/md5.js'
import { startBroadcastServer } from '../src/server.js'
import { hasDocker, SOKETI_APP, startSoketi } from './soketi.js'
import { startWorkerdHub } from './workerd.js'

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
    const config = setup.broadcaster().client()!
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
    after.close(ann)
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
      client.configureBroadcast({ ...setup.broadcaster().client()!, authEndpoint: `${siteUrl}/_caldera/broadcast/auth` })
      client.configureBroadcast({ ...setup.broadcaster().client()!, authEndpoint: `${siteUrl}/_caldera/broadcast/auth` }) // the same: no change
      expect(told).toEqual([before + 1])
      stop()

      const first = client.subscribe('posts.{post}', { post: 1 })!
      const second = client.subscribe('posts.{post}', { post: 1 })!
      expect(first.channel).toBe(second.channel)
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
      const other = new Pusher(SOKETI_APP.key, { ...setup.broadcaster().client()!, cluster: '', channelAuthorization: { endpoint: `${siteUrl}/_caldera/broadcast/auth`, transport: 'ajax' } })
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

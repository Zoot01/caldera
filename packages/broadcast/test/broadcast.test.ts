import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { createApp, defineEnv } from '@caldera/core'
import { createDatabase, setDefaultDatabase } from '@caldera/db'
import { createEvents, defineEvent, setDefaultEvents, type BroadcastPayload } from '@caldera/events'
import { createQueue, setDefaultQueue } from '@caldera/queue'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import PusherModule, { type Channel } from 'pusher-js'
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { broadcastProvider, broadcastRoutes, createBroadcaster, defineChannel, setDefaultBroadcaster, type Broadcaster } from '../src/index.js'
import { md5 } from '../src/md5.js'
import { hasDocker, SOKETI_APP, startSoketi } from './soketi.js'

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

// A real Pusher-compatible server (Soketi, in Docker) and the real pusher-js client.
describe.runIf(hasDocker)('over a real pusher-protocol server (Soketi)', { timeout: 30_000 }, () => {
  let soketi: Awaited<ReturnType<typeof startSoketi>>
  let setup: ReturnType<typeof makeApp>
  const clients: InstanceType<typeof Pusher>[] = []
  beforeAll(async () => {
    soketi = await startSoketi()
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
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { createApp, defineEnv } from '@caldera-js/core'
import { createDatabase, setDefaultDatabase, type Database } from '@caldera-js/db'
import { createMail, mailProvider, setDefaultMail, type MailService } from '@caldera-js/mail'
import { createQueue, queueProvider, setDefaultQueue } from '@caldera-js/queue'
import { sql } from 'drizzle-orm'
import { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql'
import { Miniflare } from 'miniflare'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { databaseChannel } from '../src/database.js'
import { createNotifications, defineNotification, inbox, NotificationFailedError, notificationsProvider, notify, route, SEND_NOTIFICATION_JOB, setDefaultNotifications, type Notifications, type StoredNotification } from '../src/index.js'
import { InvoicePaid, InvoicePaidEmail, QueuedInvoicePaid, Sms, sms, smsFailures, Users, type User } from './fixtures/notifications.js'
import { hasPostgres, startPostgres } from './postgres-server.js'

const PG_TABLE = `create table caldera_notifications (
  id text primary key, type text not null, notifiable_type text not null, notifiable_id text not null,
  data jsonb not null, read_at bigint, created_at bigint not null)`
const SQLITE_TABLE = PG_TABLE.replace('jsonb', 'text').replaceAll('bigint', 'integer')

const ann: User = { id: 1, email: 'ann@example.test', name: 'Ann', phone: '+15550001', wantsSms: true }
const bob: User = { id: 2, email: 'bob@example.test', name: 'Bob', phone: null, wantsSms: false }
const invoice = { number: 'INV-7', amount: 120, name: 'Ann' }

let pgServer: Awaited<ReturnType<typeof startPostgres>> | undefined
beforeAll(async () => {
  if (hasPostgres) pgServer = await startPostgres()
}, 60_000)
afterAll(async () => {
  await pgServer?.stop()
})

interface Backend {
  name: string
  setup(): Promise<{ db: Database<any>; teardown(): Promise<void> }>
}
const backends: Backend[] = [
  {
    name: 'sqlite (libsql file)',
    async setup() {
      const dir = mkdtempSync(join(tmpdir(), 'caldera-n-'))
      const client = createClient({ url: `file:${join(dir, 'n.db')}` })
      const db = createDatabase(drizzleLibsql({ client }), { driver: 'sqlite' })
      await db.client.run(sql.raw(SQLITE_TABLE))
      return { db, teardown: async () => (client.close(), rmSync(dir, { recursive: true, force: true })) }
    },
  },
  {
    name: 'D1 (workerd, Miniflare)',
    async setup() {
      const mf = new Miniflare({ modules: true, script: 'export default { fetch: () => new Response(null) }', d1Databases: ['DB'], compatibilityDate: '2026-07-30' })
      const d1 = await mf.getD1Database('DB')
      await d1.exec(SQLITE_TABLE.replaceAll('\n', ' '))
      return { db: createDatabase(drizzleD1(d1 as never), { driver: 'd1' }), teardown: () => mf.dispose() }
    },
  },
  ...(hasPostgres
    ? [
        {
          name: 'postgres (real server)',
          async setup() {
            const pool = new pg.Pool({ connectionString: pgServer!.url, max: 5 })
            const db = createDatabase(drizzlePg({ client: pool }), { driver: 'postgres' })
            await db.client.execute(sql.raw('drop table if exists caldera_notifications'))
            await db.client.execute(sql.raw(PG_TABLE))
            return { db, teardown: () => pool.end() }
          },
        },
      ]
    : []),
]

const memoryMail = () => createMail({ default: 'memory', mailers: { memory: { driver: 'memory' } }, from: 'Billing <billing@example.test>' })

afterEach(() => {
  sms.length = 0
  smsFailures.remaining = 0
  setDefaultDatabase(undefined)
  setDefaultQueue(undefined)
  setDefaultMail(undefined)
  setDefaultNotifications(undefined)
})

describe.each(backends)('notifications on $name', (backend) => {
  let db: Database<any>
  let teardown: () => Promise<void>
  let mail: MailService
  let notifications: Notifications
  beforeEach(async () => {
    ;({ db, teardown } = await backend.setup())
    setDefaultDatabase(() => db)
    mail = memoryMail()
    notifications = createNotifications({ notifications: [InvoicePaid, QueuedInvoicePaid], channels: [databaseChannel(), Sms], notifiable: Users, mail: () => mail })
    return () => teardown()
  })

  it('sends over mail, the database and a custom channel, with one id per notifiable', async () => {
    const report = await notifications.send(ann, InvoicePaid, invoice)
    const [result] = report.results
    expect(result!.channels.map((c) => [c.channel, c.status])).toEqual([
      ['mail', 'sent'],
      ['database', 'sent'],
      ['sms', 'sent'],
    ])
    const [message] = mail.outbox()!.messages
    expect(message).toMatchObject({ subject: 'Invoice INV-7 paid', to: [{ email: 'ann@example.test', name: 'Ann' }] })
    expect(message!.html).toContain('invoice <!-- -->INV-7')
    expect(sms).toEqual([{ to: '+15550001', text: 'Invoice INV-7 paid', id: result!.id }])
    const [stored] = await notifications.inbox(ann).list()
    expect(stored).toMatchObject({ id: result!.id, type: 'billing.invoice-paid', data: { number: 'INV-7', amount: 120 }, readAt: null })
    expect(stored!.createdAt).toBeInstanceOf(Date)
  })

  it('skips a channel whose handler returns nothing (no phone number)', async () => {
    const report = await notifications.send(bob, InvoicePaid, { ...invoice, name: 'Bob' })
    expect(report.results[0]!.channels.find((c) => c.channel === 'sms')!.status).toBe('skipped')
    expect(sms).toEqual([])
  })

  it('keeps each inbox to its owner: reads, marks and deletes never reach another notifiable', async () => {
    await notifications.send([ann, bob], InvoicePaid, invoice)
    const [annRow] = await notifications.inbox(ann).list()
    const bobInbox = notifications.inbox(bob)
    expect(await bobInbox.markRead(annRow!.id)).toBe(0)
    expect(await bobInbox.delete([annRow!.id])).toBe(0)
    expect(await notifications.inbox(ann).unreadCount()).toBe(1)
    expect(await bobInbox.unreadCount()).toBe(1)
    // find() is scoped the same way.
    expect(await notifications.inbox(ann).find(annRow!.id)).toMatchObject({ id: annRow!.id, type: 'billing.invoice-paid', data: { number: 'INV-7' } })
    expect(await bobInbox.find(annRow!.id)).toBeUndefined()
    expect(await bobInbox.find('nope')).toBeUndefined()
  })

  it('marks read and unread, counts unread, and pages newest first', async () => {
    for (let i = 1; i <= 5; i++) {
      await notifications.send(ann, InvoicePaid, { ...invoice, number: `INV-${i}` })
      await new Promise((r) => setTimeout(r, 2))
    }
    const box = notifications.inbox(ann)
    const first = await box.list({ limit: 2 })
    expect(first.map((n) => (n.data as { number: string }).number)).toEqual(['INV-5', 'INV-4'])
    const second = await box.list({ limit: 2, before: first[1]!.id })
    expect(second.map((n) => (n.data as { number: string }).number)).toEqual(['INV-3', 'INV-2'])
    expect(await box.markRead([first[0]!.id, first[1]!.id])).toBe(2)
    expect(await box.markRead(first[0]!.id)).toBe(0) // already read
    expect(await box.unreadCount()).toBe(3)
    expect((await box.list({ unread: true })).map((n) => (n.data as { number: string }).number)).toEqual(['INV-3', 'INV-2', 'INV-1'])
    expect((await box.list())[0]!.readAt).toBeInstanceOf(Date)
    expect(await box.markUnread(first[0]!.id)).toBe(1)
    expect(await box.markAllRead()).toBe(4)
    expect(await box.unreadCount()).toBe(0)
    expect(await box.delete(first.map((n) => n.id))).toBe(2)
    expect(await box.list()).toHaveLength(3)
  })

  it('stores a notification once even if the same send is delivered twice (a retried job)', async () => {
    const channel = databaseChannel()
    const notifiable = Users.of(ann)
    await channel.send({ type: 'x', data: { a: 1 } }, { notifiable, notification: 'x', id: 'same-id' })
    await channel.send({ type: 'x', data: { a: 1 } }, { notifiable, notification: 'x', id: 'same-id' })
    expect(await channel.inbox(notifiable).list()).toHaveLength(1)
  })

  // D1 has no interactive transactions (db.transaction throws a CapabilityError there).
  it.skipIf(backend.name.startsWith('D1'))('writes through the current transaction: rolled back with it', async () => {
    await expect(
      db.transaction(async () => {
        await notifications.send(ann, InvoicePaid, invoice)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await notifications.inbox(ann).list()).toEqual([])
  })

  it('validates the stored data against its schema', async () => {
    const Bad = defineNotification({
      name: 'bad',
      payload: z.object({}),
      channels: { database: { schema: z.object({ n: z.number() }), data: () => ({ n: 'nope' as unknown as number }) } },
    })
    await expect(notifications.send(ann, Bad, {})).rejects.toThrow(NotificationFailedError)
    expect(await notifications.inbox(ann).list()).toEqual([])
  })

  // D1 has no interactive transactions (db.transaction throws a CapabilityError there).
  it.skipIf(backend.name.startsWith('D1'))('queues one job per channel, routed per channel, and only once the transaction commits', async () => {
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
    queue.register(notifications.job as never)
    setDefaultQueue(queue)
    const fake = queue.fake()
    await db.transaction(async () => {
      const report = await notifications.send(ann, QueuedInvoicePaid, invoice)
      expect(report.results[0]!.channels.map((c) => c.status)).toEqual(['queued', 'queued', 'queued'])
      expect(fake.dispatched()).toHaveLength(0) // not before commit
    })
    const jobs = fake.dispatched()
    expect(jobs.map((j) => [j.payload.channel, j.envelope.queue])).toEqual([
      ['mail', 'mail'],
      ['database', 'default'],
      ['sms', 'default'],
    ])
    expect(new Set(jobs.map((j) => j.payload.id)).size).toBe(1)
    expect(mail.outbox()!.messages).toHaveLength(0)

    // The sms gateway is down once: only that job retries; mail and the inbox aren't repeated.
    smsFailures.remaining = 1
    const results = await fake.drain()
    expect(results.map((r) => [r.envelope.payload && (r.envelope.payload as { channel: string }).channel, r.outcome.status])).toEqual([
      ['mail', 'done'],
      ['database', 'done'],
      ['sms', 'retry'],
      ['sms', 'done'],
    ])
    expect(mail.outbox()!.messages).toHaveLength(1)
    expect(sms).toHaveLength(1)
    expect(await notifications.inbox(ann).list()).toHaveLength(1)
  })

  // D1 has no interactive transactions (db.transaction throws a CapabilityError there).
  it.skipIf(backend.name.startsWith('D1'))('drops the queued jobs on rollback', async () => {
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
    setDefaultQueue(queue)
    const fake = queue.fake()
    await expect(
      db.transaction(async () => {
        await notifications.send(ann, QueuedInvoicePaid, invoice)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(fake.dispatched()).toHaveLength(0)
  })
})

describe('without a database', () => {
  it('mails a recipient in their language, when they have one', async () => {
    const mail = memoryMail()
    const locales: (string | undefined)[] = []
    const spy = { to: (address: unknown) => ({ ...mail.to(address as never), locale: (locale: string | undefined) => (locales.push(locale), mail.to(address as never).locale(locale)) }) }
    const notifications = createNotifications({ channels: [Sms], mail: () => spy as never })
    await notifications.send(route({ mail: 'ops@example.test' }, { locale: 'fr' }), InvoicePaid, invoice)
    await notifications.send(route({ mail: 'ops@example.test' }), InvoicePaid, invoice)
    expect(locales).toEqual(['fr'])
  })

  it('sends on demand to a route, and refuses the database channel for it before sending anything', async () => {
    const mail = memoryMail()
    const notifications = createNotifications({ channels: [Sms], mail: () => mail })
    await notifications.send(route({ mail: 'ops@example.test' }), InvoicePaid, invoice)
    expect(mail.outbox()!.messages[0]!.to).toEqual([{ email: 'ops@example.test' }])

    const AlwaysDb = defineNotification({ name: 'always-db', payload: InvoicePaid.payload, channels: { mail: InvoicePaid.channels.mail, database: InvoicePaid.channels.database } })
    await expect(notifications.send(route({ mail: 'ops@example.test' }), AlwaysDb, invoice)).rejects.toThrow(/on-demand recipient .* can't use the database channel/)
    expect(mail.outbox()!.messages).toHaveLength(1)
  })

  it('attempts every channel, then throws the failure', async () => {
    const mail = memoryMail()
    const notifications = createNotifications({ channels: [Sms], notifiable: Users, mail: () => mail })
    const OnlyMailAndSms = defineNotification({ name: 'mail-sms', payload: InvoicePaid.payload, channels: { sms: InvoicePaid.channels.sms, mail: InvoicePaid.channels.mail } })
    smsFailures.remaining = 1
    const error = await notifications.send(ann, OnlyMailAndSms, invoice).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotificationFailedError)
    expect((error as NotificationFailedError).message).toMatch(/failed on 1 channel\(s\); first: sms → user:1: sms gateway down/)
    expect(mail.outbox()!.messages).toHaveLength(1) // mail still went out
  })

  it('explains what is missing: the database channel, a custom channel, a default notifiable', async () => {
    const notifications = createNotifications({ mail: () => memoryMail() })
    expect(() => notifications.inbox(Users.of(ann))).toThrow(/import \{ databaseChannel \} from '@caldera-js\/notifications\/database'/)
    const MailAndSms = defineNotification({ name: 'mail-sms', payload: InvoicePaid.payload, channels: { mail: InvoicePaid.channels.mail, sms: InvoicePaid.channels.sms } })
    await expect(notifications.send(Users.of(ann), MailAndSms, invoice)).rejects.toThrow(/"sms" channel, which isn't set up/)
    await expect(notifications.send(Users.of(ann), InvoicePaid, invoice)).rejects.toThrow(/database channel isn't set up/)
    await expect(notifications.send(ann, InvoicePaid, invoice)).rejects.toThrow(/no default notifiable is set/)
    await expect(notifications.send(Users.of(ann), InvoicePaid, { number: 1 } as never)).rejects.toThrow()
  })

  it('refuses a via() channel the notification has no handler for', async () => {
    const Wrong = defineNotification({ name: 'wrong', payload: InvoicePaid.payload, channels: { mail: InvoicePaid.channels.mail }, via: () => ['push' as 'mail'] })
    await expect(createNotifications({ notifiable: Users }).send(ann, Wrong, invoice)).rejects.toThrow(/via\(\) chose "push"/)
  })

  it('fakes: records sends without delivering, with assertions', async () => {
    const mail = memoryMail()
    const notifications = createNotifications({ channels: [Sms], notifiable: Users, mail: () => mail })
    const fake = notifications.fake()
    await notifications.send([ann, bob], InvoicePaid, invoice)
    await notifications.send(route({ mail: 'ops@example.test' }), InvoicePaid, invoice)
    expect(mail.outbox()!.messages).toHaveLength(0)
    fake.assertSentTo(ann, InvoicePaid)
    fake.assertSentTo({ type: 'user', id: 2 }, InvoicePaid, (p, channels) => p.number === 'INV-7' && channels.includes('database'), 1)
    fake.assertSentOnDemand(InvoicePaid, (_p, routes) => routes.mail === 'ops@example.test')
    expect(() => fake.assertNotSentTo(ann, InvoicePaid)).toThrow(/not to be sent/)
    expect(() => fake.assertSentTo(ann, QueuedInvoicePaid)).toThrow(/Sent: billing.invoice-paid → user:1/)
    fake.restore()
    expect(() => notifications.fake().assertNothingSent()).not.toThrow()
  })
})

describe('a notification from another copy of the module', () => {
  it('sends it, while registering two different ones under one name still fails', async () => {
    const mail = memoryMail()
    const notifications = createNotifications({ notifications: [InvoicePaid], channels: [Sms], notifiable: Users, mail: () => mail })
    const copy = defineNotification({ name: InvoicePaid.name, payload: InvoicePaid.payload, channels: { mail: InvoicePaid.channels.mail } })
    await notifications.send(ann, copy, invoice)
    expect(mail.outbox()!.messages).toHaveLength(1)
    expect(() => notifications.register(copy)).toThrow('Two different notifications are named "billing.invoice-paid".')
  })
})

describe('provider', () => {
  it('registers notify() and the job, so a queued notification is delivered by the app’s queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caldera-n-'))
    const client = createClient({ url: `file:${join(dir, 'n.db')}` })
    const db = createDatabase(drizzleLibsql({ client }), { driver: 'sqlite' })
    await db.client.run(sql.raw(SQLITE_TABLE))
    setDefaultDatabase(() => db)
    const app = createApp({
      env: defineEnv({}),
      providers: [
        queueProvider(() => ({ default: 'sync', connections: { sync: { driver: 'sync' } } })),
        mailProvider(() => ({ default: 'memory', mailers: { memory: { driver: 'memory' } }, from: 'billing@example.test' }), { mails: [InvoicePaidEmail] }),
        notificationsProvider({ notifications: [QueuedInvoicePaid], notifiable: Users, channels: [databaseChannel(), Sms] }),
      ],
    })
    await app.boot({ env: {} })
    const services = app.services as unknown as { notifications: Notifications; mail: MailService }
    expect(services.notifications.channels).toEqual(['mail', 'database', 'sms'])
    await notify(ann, QueuedInvoicePaid, invoice)
    expect(services.mail.outbox()!.messages.map((m) => m.subject)).toEqual(['Invoice INV-7 paid'])
    expect(sms).toHaveLength(1)
    expect(await inbox(ann).unreadCount()).toBe(1)
    expect(SEND_NOTIFICATION_JOB).toBe('caldera.send-notification')
    await app.shutdown()
    client.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('types', () => {
  it('checks payloads and channel names at compile time', () => {
    const check = () => {
      // @ts-expect-error: amount must be a number
      void notify(ann, InvoicePaid, { number: 'INV-1', amount: '12', name: 'Ann' })
      defineNotification({
        name: 'typed',
        payload: z.object({ n: z.number() }),
        channels: { mail: (_r, p) => ({ mail: InvoicePaidEmail, props: { name: 'x', number: String(p.n), amount: p.n } }) },
        // @ts-expect-error: "sms" isn't one of its channels
        via: () => ['mail', 'sms'],
      })
      defineNotification({
        name: 'typed-queue',
        payload: z.object({}),
        channels: { mail: () => ({ mail: InvoicePaidEmail, props: {} }) },
        // @ts-expect-error: per-channel settings only for its own channels
        queue: { perChannel: { push: { queue: 'x' } } },
      })
    }
    expect(check).toBeTypeOf('function')
  })
})

// What `caldera generate` writes into register.d.ts.
declare module '../src/index.js' {
  interface NotificationRegistry {
    'billing.invoice-paid': typeof InvoicePaid
    'billing.invoice-paid-queued': typeof QueuedInvoicePaid
  }
}

it('types a stored notification’s data by its name', () => {
  expectTypeOf<StoredNotification['type']>().toEqualTypeOf<'billing.invoice-paid' | 'billing.invoice-paid-queued'>()
  const narrow = (n: StoredNotification) => (n.type === 'billing.invoice-paid' ? n.data : undefined)
  expectTypeOf(narrow).returns.toEqualTypeOf<{ number: string; amount: number } | undefined>()
})

import { CalderaError, defineProvider, type Duration, type RegisteredServices } from '@caldera/core'
import { z } from 'zod'
import {
  isNotifiable,
  type AnyNotification,
  type ChannelContext,
  type ChannelDefinition,
  type DatabaseMessage,
  type MailMessage,
  type Notifiable,
  type NotifiableDefinition,
  type NotificationPayload,
} from './notification.js'

/** A stored notification, as the database channel reads it back. */
export interface StoredNotification {
  id: string
  /** The notification's name. */
  type: string
  data: unknown
  readAt: Date | null
  createdAt: Date
}

/** One notifiable's database notifications. Every call is scoped to it, so ids from a request can't reach anyone else's. */
export interface Inbox {
  /** Newest first. `before` is the last id of the previous page. */
  list(options?: { unread?: boolean; limit?: number; before?: string }): Promise<StoredNotification[]>
  unreadCount(): Promise<number>
  markRead(ids: string | readonly string[]): Promise<number>
  markAllRead(): Promise<number>
  markUnread(ids: string | readonly string[]): Promise<number>
  delete(ids: string | readonly string[]): Promise<number>
}

/** What `@caldera/notifications/database` adds: the `database` channel and the inbox it reads. */
export interface DatabaseChannel extends ChannelDefinition<{ type: string; data: unknown }> {
  readonly name: 'database'
  inbox(notifiable: Notifiable): Inbox
}

export interface SendReport {
  /** One per notifiable, in order. */
  results: { notifiable: Notifiable; id: string; channels: { channel: string; status: 'sent' | 'queued' | 'skipped' | 'failed'; error?: unknown }[] }[]
}

/** Thrown by an unqueued send when a channel failed. The other channels were still attempted. */
export class NotificationFailedError extends CalderaError {
  constructor(
    readonly notification: string,
    readonly failures: { channel: string; notifiable: Notifiable; error: unknown }[],
  ) {
    const first = failures[0]!
    super(
      'notification_failed',
      `Notification "${notification}" failed on ${failures.length} channel(s); first: ${first.channel} → ${first.notifiable.type}:${first.notifiable.id}: ${first.error instanceof Error ? first.error.message : String(first.error)}`,
      { channels: failures.map((f) => f.channel) },
    )
    ;(this as { cause?: unknown }).cause = first.error
  }
}

/** Anything `notify()` accepts: a recipient from `defineNotifiable(...).of(row)` or `route(...)`, or a row the default notifiable adapts. */
export type Recipient = Notifiable | object

export interface NotificationsFake {
  sent<N extends AnyNotification>(notification?: N): { notification: string; notifiable: Notifiable; payload: NotificationPayload<N>; channels: string[] }[]
  /** `to` is a notifiable, a row (via the default notifiable), or `{ type, id }`. */
  assertSentTo<N extends AnyNotification>(to: Recipient | { type: string; id: string | number }, notification: N, match?: (payload: NotificationPayload<N>, channels: string[]) => boolean, times?: number): void
  assertNotSentTo<N extends AnyNotification>(to: Recipient | { type: string; id: string | number }, notification: N): void
  assertSentOnDemand<N extends AnyNotification>(notification: N, match?: (payload: NotificationPayload<N>, routes: Readonly<Record<string, unknown>>) => boolean): void
  assertNothingSent(): void
  restore(): void
}

export interface Notifications {
  /** Sends now, or queues when the notification says `queue`. */
  send<N extends AnyNotification>(to: Recipient | readonly Recipient[], notification: N, payload: NotificationPayload<N>): Promise<SendReport>
  /** Sends now, even a queued notification. */
  sendNow<N extends AnyNotification>(to: Recipient | readonly Recipient[], notification: N, payload: NotificationPayload<N>): Promise<SendReport>
  /** The database notifications of one notifiable. Needs the database channel. */
  inbox(to: Recipient): Inbox
  register(...notifications: AnyNotification[]): void
  find(name: string): AnyNotification | undefined
  readonly notifications: readonly AnyNotification[]
  readonly channels: readonly string[]
  /** Records sends without delivering anything. */
  fake(): NotificationsFake
  /** The built-in job queued notifications run as, for registering with a queue. */
  readonly job: unknown
  services: RegisteredServices
}

export const SEND_NOTIFICATION_JOB = 'caldera.send-notification'

const recipientSchema = z.object({ kind: z.literal('caldera.recipient'), type: z.string(), id: z.string(), routes: z.record(z.string(), z.unknown()), onDemand: z.boolean() })
const jobPayload = z.object({ notification: z.string(), payload: z.unknown(), notifiable: recipientSchema, channel: z.string(), id: z.string() })

interface QueueLike {
  dispatch(job: unknown, payload: unknown, options?: { delay?: Duration; afterCommit?: boolean; queue?: string }): Promise<{ id: string; dispatched: boolean }>
  register(...jobs: unknown[]): void
}
interface MailLike {
  to(address: unknown): { send(mail: unknown, props: unknown): Promise<unknown> }
}

const fromGlobal = <T>(key: string) => (globalThis as { [key: symbol]: unknown })[Symbol.for(key)] as T | undefined

export function createNotifications(
  options: {
    notifications?: readonly AnyNotification[]
    /** Custom channels (`defineChannel`), and `databaseChannel()` from `@caldera/notifications/database`. */
    channels?: readonly ChannelDefinition<any>[]
    /** How `notify(user, ...)` turns a plain row into a notifiable, usually your users. */
    notifiable?: NotifiableDefinition<any>
    queue?: () => QueueLike | undefined
    mail?: () => MailLike | undefined
  } = {},
): Notifications {
  const registry = new Map<string, AnyNotification>()
  const channels = new Map<string, ChannelDefinition<any>>()
  for (const channel of options.channels ?? []) {
    if (channels.has(channel.name)) throw new CalderaError('channel_duplicate', `Two channels are named "${channel.name}".`)
    channels.set(channel.name, channel)
  }
  const queueOf = () => {
    const queue = options.queue?.() ?? fromGlobal<QueueLike>('caldera.queue.default')
    if (!queue) throw new CalderaError('no_queue', 'A queued notification needs a queue: add queueProvider() from @caldera/queue to the app.')
    return queue
  }
  const mailOf = () => {
    const mail = options.mail?.() ?? fromGlobal<MailLike>('caldera.mail.default')
    if (!mail) throw new CalderaError('no_mail', 'The mail channel needs mail: add mailProvider() from @caldera/mail to the app.')
    return mail
  }
  const databaseOf = () => {
    const channel = channels.get('database') as DatabaseChannel | undefined
    if (!channel) {
      throw new CalderaError('database_channel_missing', "The database channel isn't set up: import { databaseChannel } from '@caldera/notifications/database' and pass `channels: [databaseChannel()]`.")
    }
    return channel
  }

  const recipient = (to: Recipient): Notifiable => {
    if (isNotifiable(to)) return to
    if (!options.notifiable) {
      throw new CalderaError('notifiable_missing', 'notify() got a plain object, and no default notifiable is set: pass `notifiable` to notificationsProvider(), or send to `Users.of(user)`.')
    }
    return options.notifiable.of(to)
  }
  const recipients = (to: Recipient | readonly Recipient[]) => (Array.isArray(to) ? to : [to]).map(recipient)

  const channelsFor = (notification: AnyNotification, notifiable: Notifiable, payload: unknown): string[] => {
    const declared = Object.keys(notification.channels).filter((name) => notification.channels[name] !== undefined)
    const chosen = notification.via ? [...notification.via(notifiable, payload)] : declared
    for (const name of chosen) {
      if (!declared.includes(name)) throw new CalderaError('channel_not_declared', `Notification "${notification.name}": via() chose "${name}", which it has no handler for.`)
    }
    // Checked before anything is sent or queued, so a mistake doesn't leave half a notification behind.
    if (notifiable.onDemand && chosen.includes('database')) {
      throw new CalderaError('database_on_demand', `Notification "${notification.name}": an on-demand recipient (route()) has no inbox, so it can't use the database channel. Leave "database" out of via() for it.`)
    }
    return [...new Set(chosen)]
  }

  const available = (notification: AnyNotification, channel: string) => {
    if (channel === 'mail') mailOf()
    else if (channel === 'database') databaseOf()
    else if (!channels.has(channel)) {
      throw new CalderaError('channel_unknown', `Notification "${notification.name}" uses the "${channel}" channel, which isn't set up: pass it in \`channels\` (defineChannel).`)
    }
  }

  /** Builds the channel's message and delivers it. `skipped`: no route, or the handler returned nothing. */
  const deliver = async (notification: AnyNotification, channel: string, notifiable: Notifiable, payload: unknown, id: string): Promise<'sent' | 'skipped'> => {
    const handler = notification.channels[channel]
    const context: ChannelContext = { notifiable, notification: notification.name, id }
    if (channel === 'mail') {
      const message = (handler as (n: Notifiable, p: unknown) => MailMessage | null | undefined)(notifiable, payload)
      const to = message?.to ?? notifiable.routes.mail
      if (!message || to === undefined || to === null) return 'skipped'
      await mailOf().to(to).send(message.mail, message.props)
      return 'sent'
    }
    if (channel === 'database') {
      if (notifiable.onDemand) throw new CalderaError('database_on_demand', `Notification "${notification.name}": an on-demand recipient has no inbox.`)
      const { schema, data } = handler as DatabaseMessage<z.ZodType>
      await databaseOf().send({ type: notification.name, data: schema.parse(data(notifiable, payload)) }, context)
      return 'sent'
    }
    const custom = channels.get(channel)
    if (!custom) throw new CalderaError('channel_unknown', `Notification "${notification.name}" uses the "${channel}" channel, which isn't set up: pass it in \`channels\` (defineChannel).`)
    const message = (handler as (n: Notifiable, p: unknown) => unknown)(notifiable, payload)
    if (message === undefined || message === null) return 'skipped'
    await custom.send(message, context)
    return 'sent'
  }

  // Defined structurally (like @caldera/queue's defineJob output), so notifications don't depend on the queue.
  const job = {
    kind: 'caldera.job',
    name: SEND_NOTIFICATION_JOB,
    payload: jobPayload,
    queue: 'default',
    tries: 3,
    backoff: [10, 60, 300],
    timeout: 60,
    retryUntil: null,
    unique: null,
    middleware: [],
    failed: undefined,
    with: (payload: unknown) => ({ job, payload }),
    fromEvent: () => {
      throw new CalderaError('not_supported', 'The send-notification job is not an event listener.')
    },
    async handle(input: z.infer<typeof jobPayload>) {
      const notification = registry.get(input.notification)
      if (!notification) throw new CalderaError('notification_missing', `No notification named "${input.notification}" is registered in this worker (add it to src/notifications).`)
      // Validated again: the code may have changed since it was queued.
      const payload = notification.payload.parse(input.payload)
      await deliver(notification, input.channel, input.notifiable as Notifiable, payload, input.id)
    },
  }

  let fake: { sent: { notification: string; notifiable: Notifiable; payload: unknown; channels: string[] }[] } | undefined

  const send = async (to: Recipient | readonly Recipient[], notification: AnyNotification, input: unknown, now: boolean): Promise<SendReport> => {
    // A same-named definition from another copy of the module (Next.js bundles pages and route
    // handlers separately) is the same one, so only boot-time registration is strict.
    if (!registry.has(notification.name)) registry.set(notification.name, notification)
    // Validated where it's sent, so a bad payload fails there, not in a worker.
    const payload = notification.payload.parse(input)
    const report: SendReport = { results: [] }
    const failures: { channel: string; notifiable: Notifiable; error: unknown }[] = []
    for (const notifiable of recipients(to)) {
      // One id per notifiable, shared by its channels (as Laravel does), so a channel can de-duplicate.
      const id = crypto.randomUUID()
      const chosen = channelsFor(notification, notifiable, payload)
      const result: SendReport['results'][number] = { notifiable, id, channels: [] }
      report.results.push(result)
      if (fake) {
        fake.sent.push({ notification: notification.name, notifiable, payload, channels: chosen })
        continue
      }
      // Missing set-up is found before anything is sent or queued, not as one failed channel among others.
      for (const channel of chosen) available(notification, channel)
      const settings = now ? null : notification.queue
      for (const channel of chosen) {
        if (settings) {
          const per = (settings.perChannel as Record<string, { queue?: string; delay?: Duration } | undefined> | undefined)?.[channel]
          const delay = per?.delay ?? settings.delay
          const queue = per?.queue ?? settings.queue
          await queueOf().dispatch(job, { notification: notification.name, payload: input, notifiable, channel, id }, {
            afterCommit: settings.afterCommit ?? true,
            ...(delay !== undefined ? { delay } : {}),
            ...(queue ? { queue } : {}),
          })
          result.channels.push({ channel, status: 'queued' })
          continue
        }
        try {
          result.channels.push({ channel, status: await deliver(notification, channel, notifiable, payload, id) })
        } catch (error) {
          // Every channel is attempted; a failed email shouldn't lose the in-app notification.
          result.channels.push({ channel, status: 'failed', error })
          failures.push({ channel, notifiable, error })
        }
      }
    }
    if (failures.length) throw new NotificationFailedError(notification.name, failures)
    return report
  }

  const register = (notification: AnyNotification) => {
    const existing = registry.get(notification.name)
    if (existing && existing !== notification) throw new CalderaError('notification_duplicate', `Two different notifications are named "${notification.name}".`)
    registry.set(notification.name, notification)
  }
  for (const notification of options.notifications ?? []) register(notification)

  const sameRecipient = (a: Notifiable, b: Recipient | { type: string; id: string | number }) => {
    const target = isNotifiable(b) ? b : options.notifiable ? options.notifiable.of(b) : (b as { type: string; id: string | number })
    return a.type === target.type && a.id === String(target.id)
  }

  return {
    services: {} as RegisteredServices,
    send: (to, notification, payload) => send(to, notification, payload, false),
    sendNow: (to, notification, payload) => send(to, notification, payload, true),
    inbox: (to) => databaseOf().inbox(recipient(to)),
    register(...list) {
      for (const notification of list) register(notification)
    },
    find: (name) => registry.get(name),
    get notifications() {
      return [...registry.values()]
    },
    get channels() {
      return ['mail', ...channels.keys()]
    },
    job,
    fake() {
      const state = { sent: [] as { notification: string; notifiable: Notifiable; payload: unknown; channels: string[] }[] }
      fake = state
      const of = (notification: AnyNotification) => state.sent.filter((s) => s.notification === notification.name)
      const describe = () => (state.sent.length ? state.sent.map((s) => `${s.notification} → ${s.notifiable.type}:${s.notifiable.id}`).join(', ') : 'nothing')
      return {
        sent: (notification) => (notification ? of(notification) : state.sent) as never,
        assertSentTo(to, notification, match, times) {
          const found = of(notification).filter((s) => sameRecipient(s.notifiable, to) && (!match || match(s.payload as never, s.channels))).length
          if (times === undefined ? found === 0 : found !== times) {
            throw new CalderaError('assertion_failed', `Expected "${notification.name}" to be sent to this notifiable${match ? ' with a matching payload' : ''} ${times ?? 'at least once'} time(s); it was ${found}. Sent: ${describe()}.`)
          }
        },
        assertNotSentTo(to, notification) {
          const found = of(notification).filter((s) => sameRecipient(s.notifiable, to)).length
          if (found) throw new CalderaError('assertion_failed', `Expected "${notification.name}" not to be sent to this notifiable; it was ${found} time(s).`)
        },
        assertSentOnDemand(notification, match) {
          if (!of(notification).some((s) => s.notifiable.onDemand && (!match || match(s.payload as never, s.notifiable.routes)))) {
            throw new CalderaError('assertion_failed', `Expected "${notification.name}" to be sent on demand${match ? ' with a match' : ''}. Sent: ${describe()}.`)
          }
        },
        assertNothingSent() {
          if (state.sent.length) throw new CalderaError('assertion_failed', `Expected no notifications; sent ${describe()}.`)
        },
        restore() {
          if (fake === state) fake = undefined
        },
      }
    },
  }
}

const DEFAULT = Symbol.for('caldera.notifications.default')
const registryGlobal = globalThis as { [DEFAULT]?: Notifications }

export function setDefaultNotifications(service: Notifications | undefined) {
  registryGlobal[DEFAULT] = service
}

export function defaultNotifications(): Notifications {
  const service = registryGlobal[DEFAULT]
  if (!service) throw new CalderaError('no_notifications', 'No notifications are configured. Add notificationsProvider() to the app, or use c.var.notifications.')
  return service
}

/** `await notify(user, InvoicePaid, { invoiceId })`: sends (or queues) on the app's notifications. */
export function notify<N extends AnyNotification>(to: Recipient | readonly Recipient[], notification: N, payload: NotificationPayload<N>) {
  return defaultNotifications().send(to, notification, payload)
}

/** The database notifications of one notifiable: `await inbox(user).list({ unread: true })`. */
export function inbox(to: Recipient): Inbox {
  return defaultNotifications().inbox(to)
}

/**
 * Registers `notifications`: `notificationsProvider({ notifications, notifiable: Users, channels: [databaseChannel()] })`,
 * with `notifications` from `.caldera/notifications.gen.ts` (generated from src/notifications). The
 * queued job is registered with the app's queue at boot, so workers can deliver.
 */
export function notificationsProvider(options: { notifications?: readonly AnyNotification[]; channels?: readonly ChannelDefinition<any>[]; notifiable?: NotifiableDefinition<any> } = {}) {
  let services: { queue?: QueueLike; mail?: MailLike } = {}
  return defineProvider({
    name: 'notifications',
    register: () => {
      const service = createNotifications({ ...options, queue: () => services.queue, mail: () => services.mail })
      setDefaultNotifications(service)
      return { notifications: service }
    },
    boot: (app) => {
      services = app.services as never
      const service = (app.services as unknown as { notifications: Notifications }).notifications
      service.services = app.services as never
      services.queue?.register(service.job)
    },
  })
}

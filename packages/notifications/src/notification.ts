import { CalderaError, type Duration } from '@caldera/core'
import type { z } from 'zod'

/** Who a notification goes to: a stored notifiable (a user, a team) or an on-demand route. */
export interface Notifiable {
  readonly kind: 'caldera.recipient'
  /** e.g. `user`. With `id`, it's what the database channel files notifications under. */
  readonly type: string
  readonly id: string
  /** Where each channel delivers: `mail` is an address, a custom channel takes whatever it needs. */
  readonly routes: Readonly<Record<string, unknown>>
  /** True for `route({ ... })`: there's no stored notifiable, so no database channel. */
  readonly onDemand: boolean
  /** Their language, for mail: the notification's email renders in it (`useLocale()`). */
  readonly locale?: string
}

/**
 * How to notify one kind of row, usually the app's users: what to file notifications under and where
 * each channel sends. `defineNotifiable({ type: 'user', id: (u) => u.id, routes: { mail: (u) => u } })`.
 */
export interface NotifiableDefinition<R> {
  readonly kind: 'caldera.notifiable'
  readonly type: string
  of(row: R): Notifiable
}

export function defineNotifiable<R>(options: {
  type: string
  id: (row: R) => string | number
  routes: Record<string, (row: R) => unknown>
  /** Their preferred language (Laravel's HasLocalePreference): mail to them renders in it. */
  locale?: (row: R) => string | null | undefined
}): NotifiableDefinition<R> {
  return {
    kind: 'caldera.notifiable',
    type: options.type,
    of: (row) => {
      const locale = options.locale?.(row)
      return {
        kind: 'caldera.recipient',
        type: options.type,
        id: String(options.id(row)),
        routes: Object.fromEntries(Object.entries(options.routes).map(([channel, route]) => [channel, route(row)])),
        onDemand: false,
        ...(locale ? { locale } : {}),
      }
    },
  }
}

/** A recipient without a stored row: `route({ mail: 'ops@example.com' })`. */
export function route(routes: Record<string, unknown>, options: { locale?: string } = {}): Notifiable {
  return { kind: 'caldera.recipient', type: 'on-demand', id: 'on-demand', routes, onDemand: true, ...(options.locale ? { locale: options.locale } : {}) }
}

export interface ChannelContext {
  notifiable: Notifiable
  /** The notification's name. */
  notification: string
  /** Shared by every channel of one notify() (Laravel does the same), for de-duplication. */
  id: string
}

/** A delivery channel beyond mail and database: Slack, SMS, push… `send` gets what the notification built. */
export interface ChannelDefinition<M> {
  readonly kind: 'caldera.channel'
  readonly name: string
  send(message: M, context: ChannelContext): Promise<void> | void
}

export function defineChannel<M>(options: { name: string; send: ChannelDefinition<M>['send'] }): ChannelDefinition<M> {
  if (options.name === 'mail' || options.name === 'database') throw new CalderaError('channel_name_reserved', `"${options.name}" is a built-in channel.`)
  if (!/^[a-z][a-zA-Z0-9_-]*$/.test(options.name)) throw new CalderaError('channel_name_invalid', `Channel name "${options.name}" should be a plain id like "slack".`)
  return { kind: 'caldera.channel', ...options }
}

export const isNotifiable = (value: unknown): value is Notifiable => (value as { kind?: unknown } | null)?.kind === 'caldera.recipient'

/** What the mail channel sends: a mail from @caldera/mail, its props, and optionally another address. */
export interface MailMessage {
  mail: { readonly kind: 'caldera.mail'; readonly name: string }
  props: unknown
  /** Overrides the notifiable's `mail` route. */
  to?: unknown
  /** Overrides the notifiable's language. */
  locale?: string
}

export interface DatabaseMessage<S extends z.ZodType> {
  /** The stored data's shape: it's validated on write and decodes rows on read. */
  schema: S
  data: (notifiable: Notifiable, payload: any) => z.input<S>
}

type ChannelHandlers<P> = {
  mail?: (notifiable: Notifiable, payload: P) => MailMessage
  database?: DatabaseMessage<z.ZodType>
} & { [channel: string]: ((notifiable: Notifiable, payload: P) => unknown) | DatabaseMessage<z.ZodType> | undefined }

export interface QueueSettings<C extends string> {
  /** Default true: inside a transaction, the jobs are queued once it commits. */
  afterCommit?: boolean
  queue?: string
  delay?: Duration
  /** Per channel: `{ mail: { queue: 'mail', delay: '1m' } }`. */
  perChannel?: Partial<Record<C, { queue?: string; delay?: Duration }>>
}

export interface NotificationOptions<P extends z.ZodType, H extends ChannelHandlers<z.output<P>>> {
  /** Stable id, e.g. `billing.invoice-paid`: stored rows and queued jobs carry it. */
  name: string
  payload: P
  /** One handler per channel. Channels are these keys, so a channel can't lack a handler. */
  channels: H
  /** Which channels for this notifiable (default: all of them), e.g. by the user's preferences. */
  via?: (notifiable: Notifiable, payload: z.output<P>) => readonly (keyof H & string)[]
  /** Queue it: one job per notifiable and channel, so a failed email retries only the email. */
  queue?: true | QueueSettings<keyof H & string>
}

export interface NotificationDefinition<P extends z.ZodType = z.ZodType, H extends ChannelHandlers<any> = ChannelHandlers<any>> {
  readonly kind: 'caldera.notification'
  readonly name: string
  readonly payload: P
  readonly channels: H
  readonly via: ((notifiable: Notifiable, payload: z.output<P>) => readonly string[]) | undefined
  readonly queue: QueueSettings<string> | null
}
export type AnyNotification = NotificationDefinition<any, any>
export type NotificationPayload<N> = N extends NotificationDefinition<infer P, any> ? z.input<P> : never

export function defineNotification<P extends z.ZodType, const H extends ChannelHandlers<z.output<P>>>(options: NotificationOptions<P, H>): NotificationDefinition<P, H> {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(options.name)) throw new CalderaError('notification_name_invalid', `Notification name "${options.name}" should be a stable id like "billing.invoice-paid".`)
  if (Object.keys(options.channels).length === 0) throw new CalderaError('notification_no_channels', `Notification "${options.name}" has no channels.`)
  return {
    kind: 'caldera.notification',
    name: options.name,
    payload: options.payload,
    channels: options.channels,
    via: options.via as NotificationDefinition<P, H>['via'],
    queue: options.queue === undefined ? null : options.queue === true ? {} : (options.queue as QueueSettings<string>),
  }
}

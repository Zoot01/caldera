import { CalderaError, CapabilityError, createManager, defineProvider, type Duration, type DriverDefinition, type Manager, type RegisterContext } from '@caldera/core'
import { z } from 'zod'
import { renderMail, type AnyMail, type AttachmentSource, type MailApp, type MailProps, type Rendered } from './mail.js'
import { formatAddress, messageSize, parseAddress, type Address, type AddressInput, type Attachment, type Message } from './message.js'
import { cloudflareMailDriver } from './cloudflare.js'
import { failoverDriver, logDriver, memoryDriver, postmarkDriver, resendDriver, roundrobinDriver, type MailCapabilities, type MailTransport, type Outbox, type SendResult } from './transports.js'

export interface MailConfig<N extends string = string> {
  default: NoInfer<N>
  mailers: { [K in N]?: { driver: string; [option: string]: unknown } | undefined }
  /** Sender when a mail doesn't set one. Without a name (`hello@example.com`), it's sent as the app's name. */
  from: AddressInput
  /** The app mails see (`useApp()`, `subject: (p, { app }) => …`). mailProvider takes it from `config.app`. */
  app?: MailApp
  replyTo?: AddressInput
  /** Development: every message goes here instead (the real recipients are kept in X-Original-To). */
  redirectTo?: AddressInput
}

export interface Envelope {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  from?: Address
  /** The recipient's language for this mail (`.locale('fr')`). */
  locale?: string
}

export interface QueueOptions {
  delay?: Duration
  /** Default true: inside a transaction the mail is queued once it commits, and never on rollback. */
  afterCommit?: boolean
  queue?: string
}

export interface PendingMail<N extends string> {
  to(...addresses: (AddressInput | AddressInput[])[]): PendingMail<N>
  cc(...addresses: (AddressInput | AddressInput[])[]): PendingMail<N>
  bcc(...addresses: (AddressInput | AddressInput[])[]): PendingMail<N>
  replyTo(...addresses: AddressInput[]): PendingMail<N>
  from(address: AddressInput): PendingMail<N>
  /** Another configured mailer than the default. */
  via(mailer: N): PendingMail<N>
  /** Renders in this language: the mail reads it with `useLocale()`, its subject function as `locale`. */
  locale(locale: string | null | undefined): PendingMail<N>
  /** Renders and sends now. */
  send<M extends AnyMail>(mail: M, props: MailProps<M>): Promise<SendResult>
  /** Queues the built-in `caldera.send-mail` job; it renders in the worker. Nothing is ever queued implicitly. */
  queue<M extends AnyMail>(mail: M, props: MailProps<M>, options?: QueueOptions): Promise<{ id: string; dispatched: boolean }>
}

export interface MailFake {
  sent<M extends AnyMail>(mail?: M): { mail: string; props: MailProps<M>; message: Message }[]
  queued<M extends AnyMail>(mail?: M): { mail: string; props: MailProps<M>; envelope: Envelope }[]
  assertSent<M extends AnyMail>(mail: M, match?: (sent: { props: MailProps<M>; message: Message }) => boolean, times?: number): void
  assertQueued<M extends AnyMail>(mail: M, match?: (queued: { props: MailProps<M>; envelope: Envelope }) => boolean, times?: number): void
  assertNotSent<M extends AnyMail>(mail: M, match?: (sent: { props: MailProps<M>; message: Message }) => boolean): void
  assertNotQueued<M extends AnyMail>(mail: M, match?: (queued: { props: MailProps<M>; envelope: Envelope }) => boolean): void
  assertNothingSent(): void
  assertNothingQueued(): void
  /** The last sent message of this mail, as rendered. */
  rendered<M extends AnyMail>(mail: M): Rendered
  restore(): void
}

export interface MailService<N extends string = string> extends PendingMail<N> {
  register(...mails: AnyMail[]): void
  find(name: string): AnyMail | undefined
  /** The app mails are sent from, as `useApp()` gives it. */
  readonly app: MailApp
  /** Every registered mail, for previews and introspection. */
  readonly mails: readonly AnyMail[]
  /** A mailer's outbox, for `log` and `memory` mailers (dev preview, tests). */
  outbox(mailer?: N): Outbox | undefined
  /** Sends an envelope (used by the queued job). */
  deliver(mail: AnyMail, props: unknown, envelope: Envelope, mailer?: N): Promise<SendResult>
  fake(): MailFake
  readonly manager: Manager<MailTransport, MailCapabilities, N>
}

export const MAIL_DRIVERS: readonly DriverDefinition<MailTransport, MailCapabilities>[] = [logDriver, memoryDriver, resendDriver, postmarkDriver, cloudflareMailDriver, failoverDriver, roundrobinDriver]

const HINTS = {
  ses: "It's in '@caldera/mail/ses': import { sesDriver } from it and pass `drivers: [sesDriver]`.",
  smtp: "It's in '@caldera/mail/smtp': import { smtpDriver } from it and pass `drivers: [smtpDriver]`.",
}

const envelopeSchema = z.object({
  to: z.array(z.object({ email: z.string(), name: z.string().optional() })),
  cc: z.array(z.object({ email: z.string(), name: z.string().optional() })),
  bcc: z.array(z.object({ email: z.string(), name: z.string().optional() })),
  replyTo: z.array(z.object({ email: z.string(), name: z.string().optional() })),
  from: z.object({ email: z.string(), name: z.string().optional() }).optional(),
  locale: z.string().optional(),
})

/** The built-in job queued mail runs as. Its payload names the mail; the worker renders it. */
export const SEND_MAIL_JOB = 'caldera.send-mail'
const sendMailPayload = z.object({ mail: z.string(), props: z.unknown(), envelope: envelopeSchema, mailer: z.string().optional() })

interface QueueLike {
  dispatch(job: unknown, payload: unknown, options?: { delay?: Duration; afterCommit?: boolean; queue?: string }): Promise<{ id: string; dispatched: boolean }>
  register(...jobs: unknown[]): void
}
interface StorageLike {
  disk(name: string): { get(key: string): Promise<Uint8Array>; info(key: string): Promise<{ contentType: string | undefined }> }
  readonly name: string
}

const currentRuntime = (): 'node' | 'bun' | 'edge' => {
  const g = globalThis as { Bun?: unknown; process?: { versions?: { node?: string } }; navigator?: { userAgent?: string } }
  // Workers with nodejs_compat (on by default) have process.versions.node too.
  if (g.navigator?.userAgent === 'Cloudflare-Workers') return 'edge'
  if (g.Bun) return 'bun'
  if (g.process?.versions?.node) return 'node'
  return 'edge'
}

const flat = (list: (AddressInput | AddressInput[])[]) => list.flat().map(parseAddress)

export function createMail<const N extends string>(
  config: MailConfig<N>,
  options: { drivers?: readonly DriverDefinition<MailTransport, MailCapabilities>[]; queue?: () => QueueLike | undefined; storage?: () => StorageLike | undefined } = {},
): MailService<N> {
  const manager = createManager({ kind: 'mail', drivers: [...MAIL_DRIVERS, ...(options.drivers ?? [])], config: { default: config.default, instances: config.mailers }, hints: HINTS })
  const app: MailApp = { name: config.app?.name ?? '', url: config.app?.url ?? '' }
  const sender = parseAddress(config.from)
  const from = sender.name || !app.name ? sender : { ...sender, name: app.name }
  const replyTo = config.replyTo ? [parseAddress(config.replyTo)] : []
  const redirectTo = config.redirectTo ? parseAddress(config.redirectTo) : undefined
  const registry = new Map<string, AnyMail>()
  const register = (mail: AnyMail) => {
    const existing = registry.get(mail.name)
    if (existing && existing !== mail) throw new CalderaError('mail_duplicate', `Two different mails are named "${mail.name}".`)
    registry.set(mail.name, mail)
  }
  // When sent: a same-named definition from another copy of the module (Next.js bundles pages and
  // route handlers separately) is the same one, so only boot-time registration is strict.
  const remember = (mail: AnyMail) => void (registry.has(mail.name) || registry.set(mail.name, mail))
  let fake: { sent: { mail: string; props: unknown; message: Message }[]; queued: { mail: string; props: unknown; envelope: Envelope }[]; rendered: Map<string, Rendered> } | undefined

  const resolveAttachments = async (sources: AttachmentSource[]): Promise<Attachment[]> => {
    const out: Attachment[] = []
    for (const source of sources) {
      if (!('kind' in source)) {
        out.push(source)
        continue
      }
      const storage = options.storage?.() ?? defaultStorage()
      if (!storage) throw new CalderaError('mail_storage_missing', 'attach.fromStorage() needs storageProvider() in the app.')
      const disk = storage.disk(source.disk ?? storage.name)
      const [content, info] = await Promise.all([disk.get(source.key), disk.info(source.key)])
      out.push({ filename: source.filename ?? source.key.split('/').pop()!, content, contentType: info.contentType ?? 'application/octet-stream' })
    }
    return out
  }

  const deliver = async (mail: AnyMail, input: unknown, envelope: Envelope, mailer: N = config.default): Promise<SendResult> => {
    remember(mail)
    if (envelope.to.length + envelope.cc.length + envelope.bcc.length === 0) throw new CalderaError('mail_no_recipients', `Mail "${mail.name}" has no recipients: call .to(...) first.`)
    const rendered = await renderMail(mail, input as never, { app, ...(envelope.locale ? { locale: envelope.locale } : {}) })
    const props = rendered.props as never
    const headers: Record<string, string> = {}
    let target = envelope
    if (redirectTo) {
      // Development safety net: nobody real gets mail; the original recipients stay visible.
      headers['X-Original-To'] = [...envelope.to, ...envelope.cc, ...envelope.bcc].map(formatAddress).join(', ')
      target = { ...envelope, to: [redirectTo], cc: [], bcc: [] }
    }
    const message: Message = {
      from: envelope.from ?? (mail.options.from ? parseAddress(mail.options.from) : from),
      to: target.to,
      cc: target.cc,
      bcc: target.bcc,
      replyTo: envelope.replyTo.length ? envelope.replyTo : mail.options.replyTo ? [parseAddress(mail.options.replyTo)] : replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers,
      attachments: await resolveAttachments((await mail.options.attachments?.(props)) ?? []),
      tags: mail.options.tags?.(props) ?? {},
    }
    if (fake) {
      fake.sent.push({ mail: mail.name, props: rendered.props, message })
      fake.rendered.set(mail.name, { subject: rendered.subject, html: rendered.html, text: rendered.text })
      return { id: `fake-${fake.sent.length}`, mailer }
    }
    const caps = manager.capabilities(mailer)
    const runtime = currentRuntime()
    if (!caps.runtimes.includes(runtime)) throw new CapabilityError(`mail.${mailer}`, `the ${runtime} runtime`, 'SMTP needs TCP sockets; on Workers use an HTTP mailer (resend, postmark, ses).')
    const size = messageSize(message)
    if (caps.maxMessageBytes !== null && size > caps.maxMessageBytes) {
      throw new CalderaError('mail_too_large', `Mail "${mail.name}" is ${(size / 1024 / 1024).toFixed(1)}MB encoded; mail.${mailer} accepts ${(caps.maxMessageBytes / 1024 / 1024).toFixed(0)}MB. Link large files instead of attaching them.`, { bytes: size })
    }
    const result = await manager.use(mailer).send(message)
    return { id: result.id, mailer: result.mailer ?? mailer }
  }

  const queueOf = () => {
    const queue = options.queue?.() ?? defaultQueue()
    if (!queue) throw new CalderaError('no_queue', 'mail.queue() needs a queue: add queueProvider() from @caldera/queue to the app.')
    return queue
  }

  const pending = (state: Envelope & { mailer?: N }): PendingMail<N> => ({
    to: (...a) => pending({ ...state, to: [...state.to, ...flat(a)] }),
    cc: (...a) => pending({ ...state, cc: [...state.cc, ...flat(a)] }),
    bcc: (...a) => pending({ ...state, bcc: [...state.bcc, ...flat(a)] }),
    replyTo: (...a) => pending({ ...state, replyTo: [...state.replyTo, ...a.map(parseAddress)] }),
    from: (a) => pending({ ...state, from: parseAddress(a) }),
    via: (mailer) => pending({ ...state, mailer }),
    locale: (locale) => pending({ ...state, ...(locale ? { locale } : {}) }),
    send: (mail, props) => deliver(mail, props, state, state.mailer),
    async queue(mail, props, queueOptions = {}) {
      remember(mail)
      // Validated now, so a bad mail fails where it was queued, not later in a worker.
      const parsed = mail.props.safeParse(props)
      if (!parsed.success) throw new CalderaError('mail_props_invalid', `Mail "${mail.name}" got props that don't match its schema.`, { issues: parsed.error.issues })
      const { mailer, ...envelope } = state
      if (fake) {
        fake.queued.push({ mail: mail.name, props, envelope })
        return { id: `fake-${fake.queued.length}`, dispatched: true }
      }
      return queueOf().dispatch(sendMailJob, { mail: mail.name, props, envelope, ...(mailer ? { mailer } : {}) }, {
        afterCommit: queueOptions.afterCommit ?? true,
        ...(queueOptions.delay !== undefined ? { delay: queueOptions.delay } : {}),
        ...(queueOptions.queue ? { queue: queueOptions.queue } : {}),
      })
    },
  })

  const empty = pending({ to: [], cc: [], bcc: [], replyTo: [] })

  // The job is defined structurally (like @caldera/queue's defineJob output), so mail doesn't depend on the queue.
  const sendMailJob = {
    kind: 'caldera.job',
    name: SEND_MAIL_JOB,
    payload: sendMailPayload,
    queue: 'default',
    tries: 3,
    backoff: [10, 60, 300],
    timeout: 60,
    retryUntil: null,
    unique: null,
    middleware: [],
    failed: undefined,
    with: (payload: unknown) => ({ job: sendMailJob, payload }),
    fromEvent: () => {
      throw new CalderaError('not_supported', 'The send-mail job is not an event listener.')
    },
    async handle(payload: z.infer<typeof sendMailPayload>) {
      const mail = registry.get(payload.mail)
      if (!mail) throw new CalderaError('mail_missing', `No mail named "${payload.mail}" is registered in this worker (add it to src/mail).`)
      await deliver(mail, payload.props, payload.envelope as Envelope, payload.mailer as N | undefined)
    },
  }

  const service: MailService<N> = {
    ...empty,
    register(...mails) {
      for (const mail of mails) register(mail)
    },
    find: (name) => registry.get(name),
    app,
    get mails() {
      return [...registry.values()]
    },
    outbox(mailer = config.default) {
      const transport = manager.use(mailer) as Partial<Outbox>
      return Array.isArray(transport.messages) ? (transport as Outbox) : undefined
    },
    deliver,
    manager,
    fake() {
      const state = { sent: [] as { mail: string; props: unknown; message: Message }[], queued: [] as { mail: string; props: unknown; envelope: Envelope }[], rendered: new Map<string, Rendered>() }
      fake = state
      const count = <T extends { mail: string }>(list: T[], mail: AnyMail, match?: (item: T) => boolean) => list.filter((i) => i.mail === mail.name && (!match || match(i))).length
      const check = (found: number, times: number | undefined, message: string) => {
        if (times === undefined ? found === 0 : found !== times) throw new CalderaError('assertion_failed', `${message} ${times ?? 'at least once'} time(s); it was ${found}.`)
      }
      return {
        sent: (mail) => state.sent.filter((s) => !mail || s.mail === mail.name) as never,
        queued: (mail) => state.queued.filter((s) => !mail || s.mail === mail.name) as never,
        assertSent: (mail, match, times) => check(count(state.sent, mail, match as never), times, `Expected "${mail.name}" to be sent${match ? ' matching' : ''}`),
        assertQueued: (mail, match, times) => check(count(state.queued, mail, match as never), times, `Expected "${mail.name}" to be queued${match ? ' matching' : ''}`),
        assertNotSent(mail, match) {
          const found = count(state.sent, mail, match as never)
          if (found) throw new CalderaError('assertion_failed', `Expected "${mail.name}" not to be sent${match ? ' matching' : ''}; it was ${found} time(s).`)
        },
        assertNotQueued(mail, match) {
          const found = count(state.queued, mail, match as never)
          if (found) throw new CalderaError('assertion_failed', `Expected "${mail.name}" not to be queued${match ? ' matching' : ''}; it was ${found} time(s).`)
        },
        assertNothingSent() {
          if (state.sent.length) throw new CalderaError('assertion_failed', `Expected no mail; sent ${state.sent.map((s) => s.mail).join(', ')}.`)
        },
        assertNothingQueued() {
          if (state.queued.length) throw new CalderaError('assertion_failed', `Expected no queued mail; queued ${state.queued.map((s) => s.mail).join(', ')}.`)
        },
        rendered(mail) {
          const found = state.rendered.get(mail.name)
          if (!found) throw new CalderaError('assertion_failed', `"${mail.name}" wasn't sent.`)
          return found
        },
        restore() {
          if (fake === state) fake = undefined
        },
      }
    },
  }
  ;(service as unknown as { job: unknown }).job = sendMailJob
  return service
}

/** The built-in job of a mail service, for registering it with a queue. */
export const sendMailJobOf = (service: MailService<any>) => (service as unknown as { job: unknown }).job

function defaultQueue(): QueueLike | undefined {
  return (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.queue.default')] as QueueLike | undefined
}
function defaultStorage(): StorageLike | undefined {
  return (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.storage.default')] as StorageLike | undefined
}

const DEFAULT = Symbol.for('caldera.mail.default')
const registryGlobal = globalThis as { [DEFAULT]?: MailService<any> }

export function setDefaultMail(service: MailService<any> | undefined) {
  registryGlobal[DEFAULT] = service
}

/** The app's mail service (set by `mailProvider`): `mail.to(user).send(WelcomeEmail, props)`. */
export const mail: PendingMail<string> = {
  to: (...a) => defaultMail().to(...a),
  cc: (...a) => defaultMail().cc(...a),
  bcc: (...a) => defaultMail().bcc(...a),
  replyTo: (...a) => defaultMail().replyTo(...a),
  from: (a) => defaultMail().from(a),
  via: (m) => defaultMail().via(m),
  locale: (l) => defaultMail().locale(l),
  send: (m, p) => defaultMail().send(m, p),
  queue: (m, p, o) => defaultMail().queue(m, p, o),
}

export function defaultMail(): MailService<any> {
  const service = registryGlobal[DEFAULT]
  if (!service) throw new CalderaError('no_mail', 'No mail is configured. Add mailProvider() to the app, or use c.var.mail.')
  return service
}

/**
 * Registers `mail` from your config: `mailProvider((app) => app.config.mail, { mails })`, with `mails`
 * from `.caldera/mails.gen.ts` (generated from src/mail). Queued mail's job is registered with the
 * app's queue at boot, so workers can send it.
 */
export function mailProvider<const N extends string>(
  resolve: (app: RegisterContext<unknown>) => MailConfig<N>,
  options: { mails?: readonly AnyMail[]; drivers?: readonly DriverDefinition<MailTransport, MailCapabilities>[] } = {},
) {
  let services: { queue?: QueueLike; storage?: StorageLike } = {}
  return defineProvider({
    name: 'mail',
    register: (app) => {
      // Mails read the app's name and URL (useApp()) from config.app unless the mail config sets them.
      const fromApp = (app.config as { app?: { name?: unknown; url?: unknown } }).app
      const resolved = resolve(app)
      const config = resolved.app || typeof fromApp?.name !== 'string' ? resolved : { ...resolved, app: { name: fromApp.name, url: typeof fromApp.url === 'string' ? fromApp.url : '' } }
      const service = createMail(config, { ...(options.drivers ? { drivers: options.drivers } : {}), queue: () => services.queue, storage: () => services.storage })
      service.register(...(options.mails ?? []))
      setDefaultMail(service)
      return { mail: service }
    },
    boot: (app) => {
      services = app.services as never
      services.queue?.register(sendMailJobOf((app.services as unknown as { mail: MailService }).mail))
    },
    shutdown: async ({ services: s }) => {
      await s.mail.manager.purge()
    },
  })
}

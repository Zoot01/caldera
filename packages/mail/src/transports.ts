import { CalderaError, defineDriver } from '@caldera/core'
import { z } from 'zod'
import { formatAddress, type Message } from './message.js'

export interface SendResult {
  /** The provider's message id, when it gives one. */
  id: string | undefined
  /** Which configured mailer sent it (useful behind failover/roundrobin). */
  mailer: string
}

export interface MailTransport {
  send(message: Message): Promise<{ id: string | undefined; mailer?: string }>
}

export interface MailCapabilities {
  /** Where it can run: SMTP needs TCP sockets, so not on Workers. */
  runtimes: readonly ('node' | 'bun' | 'edge')[]
  /** Largest message accepted, after base64 encoding; null when there's no known limit. */
  maxMessageBytes: number | null
  attachments: boolean
  tags: boolean
}

/** A provider refused or failed. `retryable` (5xx, 429, network) tells failover whether trying another mailer can help. */
export class MailSendError extends CalderaError {
  readonly retryable: boolean

  constructor(mailer: string, message: string, options: { status?: number; retryable: boolean; provider?: unknown }) {
    super('mail_send_failed', `${mailer}: ${message}`, { mailer, status: options.status, provider: options.provider })
    this.retryable = options.retryable
  }
}

const b64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
export const toBase64 = b64

export async function postJson(mailer: string, url: string, body: unknown, headers: Record<string, string>, fetcher: typeof fetch = fetch) {
  let response: Response
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) })
  } catch (error) {
    throw new MailSendError(mailer, `couldn't reach ${new URL(url).host} (${(error as Error).message})`, { retryable: true })
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail = String(json.message ?? json.Message ?? json.error ?? response.statusText)
    throw new MailSendError(mailer, `HTTP ${response.status}: ${detail}`, { status: response.status, retryable: response.status >= 500 || response.status === 429, provider: json })
  }
  return json
}

// --- log and memory ---------------------------------------------------------------------------

export interface Outbox {
  /** Every message sent through this mailer, newest last. */
  readonly messages: readonly (Message & { id: string; sentAt: string })[]
  clear(): void
  /**
   * Under `caldera dev`: what every process sent, queue workers included (the shared outbox).
   * Attachments carry their size, not content. Empty elsewhere.
   */
  shared?(): Promise<OutboxEntry[]>
}

/** A message as the shared outbox file keeps it. */
export interface OutboxEntry extends Omit<Message, 'attachments'> {
  id: string
  sentAt: string
  attachments: { filename: string; contentType: string; size: number }[]
}

/**
 * The shared dev outbox, when a Caldera dev process installed one (`caldera dev`, `queue:work`): file
 * I/O lives there, so this package stays free of Node imports for edge bundles.
 */
interface SharedOutbox {
  append(entry: OutboxEntry): void | Promise<void>
  read(): Promise<OutboxEntry[]>
}
const sharedOutbox = () => (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.dev.mailOutbox')] as SharedOutbox | undefined

/**
 * Keeps messages in memory (an outbox) instead of sending them; `log` also prints a line per message.
 * Under `caldera dev` each message also goes to the shared outbox, so the dev server's page shows
 * what a queue worker in another process sent.
 */
export function memoryTransport(options: { log?: boolean; limit?: number } = {}): MailTransport & Outbox {
  const messages: (Message & { id: string; sentAt: string })[] = []
  return {
    messages,
    clear: () => void messages.splice(0),
    shared: async () => (await sharedOutbox()?.read()) ?? [],
    async send(message) {
      const id = crypto.randomUUID()
      const sentAt = new Date().toISOString()
      messages.push({ ...message, id, sentAt })
      if (messages.length > (options.limit ?? 200)) messages.shift()
      try {
        await sharedOutbox()?.append({ ...message, id, sentAt, attachments: message.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })) })
      } catch {
        // The shared outbox is a development aid; the message is already in this outbox.
      }
      if (options.log) console.log(`[mail] "${message.subject}" → ${message.to.map(formatAddress).join(', ')} (${message.attachments.length} attachment(s); see /_caldera/mail/outbox)`)
      return { id }
    },
  }
}

const everywhere = ['node', 'bun', 'edge'] as const
export const logDriver = defineDriver<MailTransport, MailCapabilities>({
  name: 'log',
  capabilities: { runtimes: everywhere, maxMessageBytes: null, attachments: true, tags: true },
  create: () => memoryTransport({ log: true }),
})
export const memoryDriver = defineDriver<MailTransport, MailCapabilities>({
  name: 'memory',
  capabilities: { runtimes: everywhere, maxMessageBytes: null, attachments: true, tags: true },
  create: () => memoryTransport(),
})

// --- Resend ------------------------------------------------------------------------------------

/** Resend's HTTP API: plain fetch, so it runs everywhere. Messages up to 40MB after encoding. */
export function resendTransport(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): MailTransport {
  const url = `${(options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`
  return {
    async send(message) {
      const json = await postJson(
        'resend',
        url,
        {
          from: formatAddress(message.from),
          to: message.to.map(formatAddress),
          ...(message.cc.length ? { cc: message.cc.map(formatAddress) } : {}),
          ...(message.bcc.length ? { bcc: message.bcc.map(formatAddress) } : {}),
          ...(message.replyTo.length ? { reply_to: message.replyTo.map(formatAddress) } : {}),
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          ...(Object.keys(message.headers).length ? { headers: message.headers } : {}),
          ...(message.attachments.length
            ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: b64(a.content), content_type: a.contentType, ...(a.contentId ? { content_id: a.contentId } : {}) })) }
            : {}),
          ...(Object.keys(message.tags).length ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}),
        },
        { authorization: `Bearer ${options.apiKey}` },
        options.fetch,
      )
      return { id: typeof json.id === 'string' ? json.id : undefined }
    },
  }
}
export const resendDriver = defineDriver<MailTransport, MailCapabilities, { apiKey: string; baseUrl?: string }>({
  name: 'resend',
  schema: z.object({ apiKey: z.string().min(1, 'set RESEND_API_KEY'), baseUrl: z.url().optional() }),
  capabilities: { runtimes: everywhere, maxMessageBytes: 40 * 1024 * 1024, attachments: true, tags: true },
  create: (config) => resendTransport(config),
})

// --- Postmark ----------------------------------------------------------------------------------

/** Postmark's HTTP API. Messages up to 10MB after encoding. Tags map to Metadata; a `category` tag becomes Postmark's Tag. */
export function postmarkTransport(options: { serverToken: string; messageStream?: string; baseUrl?: string; fetch?: typeof fetch }): MailTransport {
  const url = `${(options.baseUrl ?? 'https://api.postmarkapp.com').replace(/\/$/, '')}/email`
  const list = (addresses: Message['to']) => addresses.map(formatAddress).join(', ')
  return {
    async send(message) {
      const json = await postJson(
        'postmark',
        url,
        {
          From: formatAddress(message.from),
          To: list(message.to),
          ...(message.cc.length ? { Cc: list(message.cc) } : {}),
          ...(message.bcc.length ? { Bcc: list(message.bcc) } : {}),
          ...(message.replyTo.length ? { ReplyTo: list(message.replyTo) } : {}),
          Subject: message.subject,
          HtmlBody: message.html,
          ...(message.text ? { TextBody: message.text } : {}),
          ...(Object.keys(message.headers).length ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
          ...(message.attachments.length
            ? { Attachments: message.attachments.map((a) => ({ Name: a.filename, Content: b64(a.content), ContentType: a.contentType, ...(a.contentId ? { ContentID: `cid:${a.contentId}` } : {}) })) }
            : {}),
          ...(message.tags.category ? { Tag: message.tags.category } : {}),
          ...(Object.keys(message.tags).length ? { Metadata: message.tags } : {}),
          MessageStream: options.messageStream ?? 'outbound',
        },
        { 'x-postmark-server-token': options.serverToken },
        options.fetch,
      )
      // Postmark answers 200 with ErrorCode for some refusals.
      if (typeof json.ErrorCode === 'number' && json.ErrorCode !== 0) throw new MailSendError('postmark', String(json.Message), { retryable: false, provider: json })
      return { id: typeof json.MessageID === 'string' ? json.MessageID : undefined }
    },
  }
}
export const postmarkDriver = defineDriver<MailTransport, MailCapabilities, { serverToken: string; messageStream?: string; baseUrl?: string }>({
  name: 'postmark',
  schema: z.object({ serverToken: z.string().min(1, 'set POSTMARK_SERVER_TOKEN'), messageStream: z.string().optional(), baseUrl: z.url().optional() }),
  capabilities: { runtimes: everywhere, maxMessageBytes: 10 * 1024 * 1024, attachments: true, tags: true },
  create: (config) => postmarkTransport(config),
})

// --- failover and roundrobin -------------------------------------------------------------------

/**
 * Tries mailers in order, moving on only when the failure could be the provider's (network, 5xx,
 * 429). A refusal of the message itself (a bad address, 4xx) is thrown at once: another provider
 * would refuse it too, or worse, send what one rejected.
 */
function chain(name: string, order: () => string[], instance: (name: string) => MailTransport): MailTransport {
  return {
    async send(message) {
      const errors: unknown[] = []
      for (const mailer of order()) {
        try {
          const result = await instance(mailer).send(message)
          return { id: result.id, mailer: result.mailer ?? mailer }
        } catch (error) {
          if (error instanceof MailSendError && !error.retryable) throw error
          errors.push(error)
        }
      }
      throw new MailSendError(name, `every mailer failed: ${errors.map((e) => (e as Error).message).join('; ')}`, { retryable: true })
    },
  }
}

const listSchema = z.object({ mailers: z.array(z.string()).min(1) })
const composite = { runtimes: everywhere, maxMessageBytes: null, attachments: true, tags: true }

export const failoverDriver = defineDriver<MailTransport, MailCapabilities, { mailers: string[] }>({
  name: 'failover',
  schema: listSchema,
  capabilities: composite,
  create: (config, context) => chain('failover', () => config.mailers, context.instance),
})

export const roundrobinDriver = defineDriver<MailTransport, MailCapabilities, { mailers: string[] }>({
  name: 'roundrobin',
  schema: listSchema,
  capabilities: composite,
  create: (config, context) => {
    let next = 0
    // Spreads the load, still failing over: each send starts at the next mailer.
    return chain('roundrobin', () => {
      const start = next++ % config.mailers.length
      return [...config.mailers.slice(start), ...config.mailers.slice(0, start)]
    }, context.instance)
  },
})

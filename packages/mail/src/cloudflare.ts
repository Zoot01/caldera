import { CalderaError, defineDriver } from '@caldera-js/core'
import { z } from 'zod'
import type { Address, Message } from './message.js'
import { MailSendError, toBase64, type MailCapabilities, type MailTransport } from './transports.js'

/** The Workers `send_email` binding (Cloudflare Email Service), structurally. */
export interface SendEmailBinding {
  send(message: Record<string, unknown>): Promise<{ messageId?: string }>
}

// Worth trying another mailer (failover): the service's capacity or delivery, not the message.
const RETRYABLE = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR', 'E_DELIVERY_FAILED', 'E_ACCOUNT_SUSPENDED'])
const MAX_RECIPIENTS = 50

const address = (a: Address) => (a.name ? { email: a.email, name: a.name } : a.email)

/**
 * Cloudflare Email Service through the Worker's `send_email` binding: `{ driver: 'cloudflare',
 * binding: env.EMAIL }`. Its structured API, so no MIME is built here. Tags become `X-Tag-*` headers.
 * Under `wrangler dev` the binding is simulated (logged, nothing sent) unless it's `remote`.
 */
export function cloudflareTransport(binding: SendEmailBinding): MailTransport {
  return {
    async send(message: Message) {
      const recipients = message.to.length + message.cc.length + message.bcc.length
      if (recipients > MAX_RECIPIENTS) {
        throw new MailSendError('cloudflare', `${recipients} recipients; Cloudflare Email Service takes at most ${MAX_RECIPIENTS} per message.`, { retryable: false })
      }
      const headers = { ...message.headers, ...Object.fromEntries(Object.entries(message.tags).map(([name, value]) => [`X-Tag-${name.replace(/[^A-Za-z0-9-]/g, '-')}`, value])) }
      let result: { messageId?: string }
      try {
        result = await binding.send({
          from: address(message.from),
          to: message.to.map(address),
          ...(message.cc.length ? { cc: message.cc.map(address) } : {}),
          ...(message.bcc.length ? { bcc: message.bcc.map(address) } : {}),
          ...(message.replyTo[0] ? { replyTo: address(message.replyTo[0]) } : {}),
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
          // Base64 strings: binary content can't cross the binding locally (wrangler dev).
          ...(message.attachments.length
            ? {
                attachments: message.attachments.map((a) => ({
                  content: toBase64(a.content),
                  filename: a.filename,
                  type: a.contentType,
                  disposition: a.contentId ? 'inline' : 'attachment',
                  ...(a.contentId ? { contentId: a.contentId } : {}),
                })),
              }
            : {}),
        })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        const text = (error as Error).message ?? String(error)
        throw new MailSendError('cloudflare', typeof code === 'string' ? `${code}: ${text}` : text, { retryable: typeof code === 'string' ? RETRYABLE.has(code) : true, provider: { code } })
      }
      return { id: result?.messageId }
    },
  }
}

export const cloudflareMailDriver = defineDriver<MailTransport, MailCapabilities, { binding: SendEmailBinding }>({
  name: 'cloudflare',
  schema: z.object({
    binding: z.custom<SendEmailBinding>((value) => typeof (value as SendEmailBinding | undefined)?.send === 'function', "must be the Worker's send_email binding (env.EMAIL)"),
  }),
  capabilities: { runtimes: ['edge'], maxMessageBytes: 25 * 1024 * 1024, attachments: true, tags: true },
  create: (config) => {
    if (!config.binding) throw new CalderaError('mail_config', 'The cloudflare mailer needs `binding: env.EMAIL`.')
    return cloudflareTransport(config.binding)
  },
})

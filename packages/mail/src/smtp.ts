import { defineDriver } from '@caldera/core'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { formatAddress } from './message.js'
import { MailSendError, type MailCapabilities, type MailTransport } from './transports.js'

const configSchema = z.object({
  /** `smtp://user:pass@host:587` or `smtps://…:465`. */
  url: z.string().regex(/^smtps?:\/\//, 'must be an smtp:// or smtps:// URL').optional(),
  host: z.string().optional(),
  port: z.number().int().optional(),
  secure: z.boolean().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
})

/** SMTP with nodemailer (pooled connections). Node and Bun only: Workers can't open SMTP sockets. */
export function smtpTransport(config: z.infer<typeof configSchema>): MailTransport & { close(): void } {
  const url = config.url ? new URL(config.url) : undefined
  const host = url?.hostname ?? config.host
  const port = url?.port ? Number(url.port) : (config.port ?? (url?.protocol === 'smtps:' ? 465 : 587))
  const user = url?.username ? decodeURIComponent(url.username) : config.user
  const password = url?.password ? decodeURIComponent(url.password) : config.password
  const transport = nodemailer.createTransport({
    pool: true,
    host,
    port,
    secure: config.secure ?? (url?.protocol === 'smtps:' || port === 465),
    ...(user ? { auth: { user, pass: password ?? '' } } : {}),
  })
  return {
    async send(message) {
      try {
        const info = await transport.sendMail({
          from: formatAddress(message.from),
          to: message.to.map(formatAddress),
          cc: message.cc.map(formatAddress),
          bcc: message.bcc.map(formatAddress),
          replyTo: message.replyTo.map(formatAddress),
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          headers: message.headers,
          attachments: message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType, ...(a.contentId ? { cid: a.contentId } : {}) })),
        })
        return { id: info.messageId }
      } catch (error) {
        const code = (error as { responseCode?: number }).responseCode
        // 4xx SMTP replies are temporary (try again or elsewhere); 5xx are refusals.
        throw new MailSendError('smtp', (error as Error).message, { ...(code ? { status: code } : {}), retryable: code === undefined || (code >= 400 && code < 500) })
      }
    },
    close: () => transport.close(),
  }
}

export const smtpDriver = defineDriver<MailTransport, MailCapabilities, z.infer<typeof configSchema>>({
  name: 'smtp',
  schema: configSchema.refine((c) => c.url || c.host, 'needs `url` or `host`'),
  capabilities: { runtimes: ['node', 'bun'], maxMessageBytes: null, attachments: true, tags: false },
  create: (config) => smtpTransport(config),
  close: (transport) => (transport as ReturnType<typeof smtpTransport>).close(),
})

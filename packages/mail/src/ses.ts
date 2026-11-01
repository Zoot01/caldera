import { defineDriver } from '@caldera-js/core'
import { AwsClient } from 'aws4fetch'
import { z } from 'zod'
import { formatAddress } from './message.js'
import { postJson, toBase64, type MailCapabilities, type MailTransport } from './transports.js'

/**
 * Amazon SES through the v2 HTTP API (SendEmail, Simple content with attachments), signed with
 * aws4fetch: runs everywhere, including Workers. Messages up to 40MB after encoding (v1 allowed 10MB).
 */
export function sesTransport(options: { region: string; accessKeyId: string; secretAccessKey: string; configurationSet?: string; endpoint?: string }): MailTransport {
  const client = new AwsClient({ accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, region: options.region, service: 'ses' })
  const url = `${(options.endpoint ?? `https://email.${options.region}.amazonaws.com`).replace(/\/$/, '')}/v2/email/outbound-emails`
  return {
    async send(message) {
      const json = await postJson(
        'ses',
        url,
        {
          FromEmailAddress: formatAddress(message.from),
          Destination: {
            ToAddresses: message.to.map(formatAddress),
            ...(message.cc.length ? { CcAddresses: message.cc.map(formatAddress) } : {}),
            ...(message.bcc.length ? { BccAddresses: message.bcc.map(formatAddress) } : {}),
          },
          ...(message.replyTo.length ? { ReplyToAddresses: message.replyTo.map(formatAddress) } : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: { Html: { Data: message.html, Charset: 'UTF-8' }, ...(message.text ? { Text: { Data: message.text, Charset: 'UTF-8' } } : {}) },
              ...(Object.keys(message.headers).length ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
              ...(message.attachments.length
                ? {
                    Attachments: message.attachments.map((a) => ({
                      FileName: a.filename,
                      RawContent: toBase64(a.content),
                      ContentType: a.contentType,
                      ContentDisposition: a.contentId ? 'INLINE' : 'ATTACHMENT',
                      ...(a.contentId ? { ContentId: a.contentId } : {}),
                    })),
                  }
                : {}),
            },
          },
          ...(Object.keys(message.tags).length ? { EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })) } : {}),
          ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
        },
        {},
        (input, init) => client.fetch(input as string, init),
      )
      return { id: typeof json.MessageId === 'string' ? json.MessageId : undefined }
    },
  }
}

export const sesDriver = defineDriver<MailTransport, MailCapabilities, { region: string; accessKeyId: string; secretAccessKey: string; configurationSet?: string; endpoint?: string }>({
  name: 'ses',
  schema: z.object({ region: z.string().min(1), accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), configurationSet: z.string().optional(), endpoint: z.url().optional() }),
  capabilities: { runtimes: ['node', 'bun', 'edge'], maxMessageBytes: 40 * 1024 * 1024, attachments: true, tags: true },
  create: (config) => sesTransport(config),
})

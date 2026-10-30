import { Hono, type Context } from 'hono'
import { renderMail } from './mail.js'
import { formatAddress } from './message.js'
import type { MailService } from './service.js'

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/**
 * Development pages: `/_caldera/mail` lists every mail, `/_caldera/mail/<name>` renders one with its
 * preview props (`?format=text` for the plain text, `?format=json` for subject/html/text/size), and
 * `/_caldera/mail/outbox` shows what the log/memory mailer "sent". Refused unless `enabled`.
 */
export function mailPreviewRoutes(options: { enabled: (c: Context) => boolean }): Hono {
  const serviceOf = (c: Context) => {
    const service = (c.var as { mail?: MailService }).mail
    if (!service) throw new Error('mailPreviewRoutes needs mailProvider() in the app.')
    return service
  }
  const page = (title: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:14px system-ui;margin:2rem;max-width:60rem}td,th{padding:.3rem .6rem;text-align:left;border-bottom:1px solid #ddd}code{font-size:.9em}</style></head><body>${body}</body></html>`
  return new Hono()
    .use('/_caldera/mail/*', async (c, next) => (options.enabled(c) ? next() : c.notFound()))
    .use('/_caldera/mail', async (c, next) => (options.enabled(c) ? next() : c.notFound()))
    .get('/_caldera/mail', (c) => {
      const mails = serviceOf(c).mails
      const rows = mails.map((m) => `<tr><td><a href="/_caldera/mail/${encodeURIComponent(m.name)}">${escape(m.name)}</a></td><td>${m.preview ? 'preview props' : '<em>no PreviewProps</em>'}</td></tr>`).join('')
      return c.html(page('Mail', `<h1>Mail</h1><p><a href="/_caldera/mail/outbox">Outbox</a></p><table><tr><th>Mail</th><th></th></tr>${rows}</table>`))
    })
    .get('/_caldera/mail/outbox', (c) => {
      const outbox = serviceOf(c).outbox()
      if (!outbox) return c.html(page('Outbox', '<h1>Outbox</h1><p>The default mailer sends for real; switch to <code>log</code> or <code>memory</code> to collect mail here.</p>'))
      const id = c.req.query('id')
      const found = id ? outbox.messages.find((m) => m.id === id) : undefined
      if (found) return c.html(found.html)
      if (c.req.header('accept')?.includes('application/json')) return c.json({ messages: outbox.messages.map(({ html: _h, attachments, ...m }) => ({ ...m, attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })) })) })
      const rows = [...outbox.messages].reverse().map((m) => `<tr><td>${escape(m.sentAt)}</td><td><a href="/_caldera/mail/outbox?id=${m.id}">${escape(m.subject)}</a></td><td>${escape(m.to.map(formatAddress).join(', '))}</td></tr>`).join('')
      return c.html(page('Outbox', `<h1>Outbox</h1><table><tr><th>Sent</th><th>Subject</th><th>To</th></tr>${rows || '<tr><td colspan="3">Nothing sent yet.</td></tr>'}</table>`))
    })
    .get('/_caldera/mail/:name', async (c) => {
      const mail = serviceOf(c).find(c.req.param('name'))
      if (!mail) return c.notFound()
      if (!mail.preview) return c.html(page(mail.name, `<p>"${escape(mail.name)}" has no preview props: set <code>Component.PreviewProps</code> or <code>preview</code> in defineMail.</p>`), 400)
      const rendered = await renderMail(mail, mail.preview as never)
      const format = c.req.query('format')
      if (format === 'text') return c.text(rendered.text ?? '')
      if (format === 'json') return c.json({ subject: rendered.subject, html: rendered.html, text: rendered.text, sizeBytes: new TextEncoder().encode(rendered.html).length })
      return c.html(rendered.html)
    })
}

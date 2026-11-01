import { createStorage, setDefaultStorage } from '@caldera-js/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMail } from '../src/index.js'
import { smtpDriver } from '../src/smtp.js'
import { InvoiceEmail, WelcomeEmail } from './fixtures/welcome.js'
import { hasDocker, startMailpit } from './mailpit.js'

describe.runIf(hasDocker)('smtp driver (Mailpit in Docker, a real SMTP server)', () => {
  let mailpit: Awaited<ReturnType<typeof startMailpit>>
  beforeAll(async () => {
    mailpit = await startMailpit()
  }, 120_000)
  afterAll(() => mailpit?.stop())

  it('delivers HTML, text, recipients and attachments', async () => {
    const storage = createStorage({ default: 'files', disks: { files: { driver: 'memory' } } })
    await storage.put('invoices/7.pdf', '%PDF-1.7 seven', { contentType: 'application/pdf' })
    setDefaultStorage(storage)
    const service = createMail({ default: 'smtp', mailers: { smtp: { driver: 'smtp', url: mailpit.smtpUrl } }, from: 'Caldera <hello@example.test>' }, { drivers: [smtpDriver] })
    try {
      await service.to({ email: 'ann@example.test', name: 'Ann Lee' }).cc('cc@example.test').send(WelcomeEmail, { name: 'Ann', loginUrl: 'https://app.example.test/login' })
      await service.to('bob@example.test').send(InvoiceEmail, { number: '7', pdf: 'invoices/7.pdf' })
      const list = (await (await fetch(`${mailpit.api}/api/v1/messages`)).json()) as { messages: { ID: string; Subject: string; To: { Address: string; Name: string }[]; Attachments: number }[] }
      const welcome = list.messages.find((m) => m.Subject === 'Welcome, Ann')!
      expect(welcome.To).toEqual([{ Address: 'ann@example.test', Name: 'Ann Lee' }])
      const detail = (await (await fetch(`${mailpit.api}/api/v1/message/${welcome.ID}`)).json()) as { From: { Address: string; Name: string }; Cc: { Address: string }[]; Text: string; HTML: string }
      expect(detail.From).toEqual({ Address: 'hello@example.test', Name: 'Caldera' })
      expect(detail.Cc.map((c) => c.Address)).toEqual(['cc@example.test'])
      expect(detail.Text).toContain('Hi Ann, your account is ready.')
      expect(detail.HTML).toContain('href="https://app.example.test/login"')
      const invoice = list.messages.find((m) => m.Subject === 'Invoice 7')!
      const withFile = (await (await fetch(`${mailpit.api}/api/v1/message/${invoice.ID}`)).json()) as { Attachments: { FileName: string; ContentType: string; Size: number }[] }
      expect(withFile.Attachments).toEqual([expect.objectContaining({ FileName: 'invoice-7.pdf', ContentType: 'application/pdf', Size: 14 })])
    } finally {
      await service.manager.purge()
      setDefaultStorage(undefined)
    }
  }, 30_000)
})

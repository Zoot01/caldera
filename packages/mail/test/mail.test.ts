import { createApp, defineEnv } from '@caldera/core'
import { createQueue, setDefaultQueue } from '@caldera/queue'
import { createStorage, setDefaultStorage } from '@caldera/storage'
import { AwsClient } from 'aws4fetch'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { createMail, MailSendError, mailPreviewRoutes, mailProvider, renderMail, sendMailJobOf, type Message } from '../src/index.js'
import { sesTransport } from '../src/ses.js'
import { postmarkTransport, resendTransport } from '../src/transports.js'
import { InvoiceEmail, WelcomeEmail } from './fixtures/welcome.js'

const props = { name: 'Ann', loginUrl: 'https://app.example.test/login' }
afterEach(() => {
  setDefaultQueue(undefined)
  setDefaultStorage(undefined)
})

describe('rendering', () => {
  it('renders React Email to HTML and plain text, with the subject from props', async () => {
    const rendered = await renderMail(WelcomeEmail, props)
    expect(rendered.subject).toBe('Welcome, Ann')
    expect(rendered.html).toContain('<!DOCTYPE html')
    expect(rendered.html).toContain('Hi <!-- -->Ann<!-- -->, your account is ready.')
    expect(rendered.html).toContain('href="https://app.example.test/login"')
    expect(rendered.text).toContain('Hi Ann, your account is ready.')
    expect(rendered.text).toContain('https://app.example.test/login')
    expect(WelcomeEmail.preview).toEqual(props) // from Welcome.PreviewProps
  })

  it('refuses props that don’t match, naming the field', async () => {
    await expect(renderMail(WelcomeEmail, { name: 'Ann', loginUrl: 'not a url' })).rejects.toThrow(/Mail "users.welcome" got props that don't match its schema: loginUrl: Invalid URL/)
  })
})

describe('sending', () => {
  const memory = () => createMail({ default: 'memory', mailers: { memory: { driver: 'memory' } }, from: 'Caldera <hello@example.test>' })

  it('builds the message: sender, recipients, tags', async () => {
    const service = memory()
    const result = await service.to({ email: 'ann@example.test', name: 'Ann Lee' }, 'Bob <bob@example.test>').cc('cc@example.test').send(WelcomeEmail, props)
    expect(result.mailer).toBe('memory')
    const [message] = service.outbox()!.messages
    expect(message).toMatchObject({ from: { name: 'Caldera', email: 'hello@example.test' }, to: [{ email: 'ann@example.test', name: 'Ann Lee' }, { email: 'bob@example.test', name: 'Bob' }], cc: [{ email: 'cc@example.test' }], subject: 'Welcome, Ann', tags: { category: 'onboarding' } })
    await expect(service.send(WelcomeEmail, props)).rejects.toThrow(/has no recipients/)
    expect(() => service.to('not-an-address')).toThrow(/isn't an email address/)
  })

  it('redirects every message in development, keeping the real recipients visible', async () => {
    const service = createMail({ default: 'memory', mailers: { memory: { driver: 'memory' } }, from: 'hello@example.test', redirectTo: 'dev@example.test' })
    await service.to('ann@example.test').bcc('secret@example.test').send(WelcomeEmail, props)
    const [message] = service.outbox()!.messages
    expect(message!.to).toEqual([{ email: 'dev@example.test' }])
    expect(message!.bcc).toEqual([])
    expect(message!.headers['X-Original-To']).toBe('ann@example.test, secret@example.test')
  })

  it('attaches files from storage when sending, and refuses messages over the provider’s limit', async () => {
    const storage = createStorage({ default: 'files', disks: { files: { driver: 'memory' } } })
    await storage.put('invoices/1.pdf', '%PDF-1.7 fake', { contentType: 'application/pdf' })
    setDefaultStorage(storage)
    const service = memory()
    await service.to('ann@example.test').send(InvoiceEmail, { number: '1', pdf: 'invoices/1.pdf' })
    expect(service.outbox()!.messages[0]!.attachments).toMatchObject([{ filename: 'invoice-1.pdf', contentType: 'application/pdf' }])
    const postmark = createMail({ default: 'pm', mailers: { pm: { driver: 'postmark', serverToken: 't' } }, from: 'hello@example.test' })
    // 8MB of attachment is ~10.7MB in base64: over Postmark's 10MB.
    await expect(postmark.to('ann@example.test').send(InvoiceEmail, { number: '2', size: 8 * 1024 * 1024 })).rejects.toThrow(/is 10\.\dMB encoded; mail\.pm accepts 10MB/)
  })

  it('fakes: records sent and queued mail, with the rendered result', async () => {
    const service = memory()
    const fake = service.fake()
    await service.to('ann@example.test').send(WelcomeEmail, props)
    await service.to('bob@example.test').queue(WelcomeEmail, { ...props, name: 'Bob' })
    fake.assertSent(WelcomeEmail, ({ message }) => message.to[0]!.email === 'ann@example.test', 1)
    fake.assertQueued(WelcomeEmail, ({ props: p }) => p.name === 'Bob')
    expect(fake.rendered(WelcomeEmail).subject).toBe('Welcome, Ann')
    expect(() => fake.assertNothingSent()).toThrow(/sent users.welcome/)
    expect(service.outbox()!.messages).toHaveLength(0)
    fake.restore()
  })
})

describe('queued mail', () => {
  it('queues the built-in job; the worker renders and sends it', async () => {
    const queue = createQueue({ default: 'memory', connections: { memory: { driver: 'memory' } } })
    setDefaultQueue(queue)
    const service = createMail({ default: 'memory', mailers: { memory: { driver: 'memory' } }, from: 'hello@example.test' })
    queue.register(sendMailJobOf(service) as never)
    const capture = queue.fake()
    await service.to('ann@example.test').queue(WelcomeEmail, props, { delay: '5m' })
    expect(capture.dispatched()[0]).toMatchObject({ job: 'caldera.send-mail', delaySeconds: 300, payload: { mail: 'users.welcome', envelope: { to: [{ email: 'ann@example.test' }] } } })
    expect(service.outbox()!.messages).toHaveLength(0)
    await capture.drain()
    expect(service.outbox()!.messages[0]!.subject).toBe('Welcome, Ann')
    await expect(service.to('a@example.test').queue(WelcomeEmail, { name: 1 } as never)).rejects.toThrow(/don't match its schema/)
  })
})

describe('failover and roundrobin', () => {
  const failing = (retryable: boolean) => ({ kind: 'caldera.driver' as const, name: retryable ? 'down' : 'refuses', capabilities: { runtimes: ['node', 'bun', 'edge'] as const, maxMessageBytes: null, attachments: true, tags: true }, create: () => ({ send: async () => { throw new MailSendError(retryable ? 'down' : 'refuses', retryable ? 'HTTP 503' : 'HTTP 422: bad address', { retryable }) } }) })

  it('moves on only when the provider failed, not when it refused the message', async () => {
    const service = createMail(
      { default: 'main', mailers: { main: { driver: 'failover', mailers: ['first', 'backup'] }, first: { driver: 'down' }, backup: { driver: 'memory' } }, from: 'hello@example.test' },
      { drivers: [failing(true) as never] },
    )
    expect((await service.to('ann@example.test').send(WelcomeEmail, props)).mailer).toBe('backup')
    const strict = createMail(
      { default: 'main', mailers: { main: { driver: 'failover', mailers: ['first', 'backup'] }, first: { driver: 'refuses' }, backup: { driver: 'memory' } }, from: 'hello@example.test' },
      { drivers: [failing(false) as never] },
    )
    await expect(strict.to('ann@example.test').send(WelcomeEmail, props)).rejects.toThrow('refuses: HTTP 422: bad address')
    expect(strict.outbox('backup')!.messages).toHaveLength(0)
  })

  it('roundrobin spreads sends across mailers', async () => {
    const service = createMail({ default: 'rr', mailers: { rr: { driver: 'roundrobin', mailers: ['a', 'b'] }, a: { driver: 'memory' }, b: { driver: 'memory' } }, from: 'hello@example.test' })
    const used = []
    for (let i = 0; i < 4; i++) used.push((await service.to('x@example.test').send(WelcomeEmail, props)).mailer)
    expect(used).toEqual(['a', 'b', 'a', 'b'])
  })
})

/** A message with everything set, for the provider contract tests. */
const fullMessage: Message = {
  from: { name: 'Caldera', email: 'hello@example.test' },
  to: [{ name: 'Ann Lee', email: 'ann@example.test' }],
  cc: [{ email: 'cc@example.test' }],
  bcc: [],
  replyTo: [{ email: 'support@example.test' }],
  subject: 'Hi',
  html: '<p>Hi</p>',
  text: 'Hi',
  headers: { 'X-Campaign': 'launch' },
  attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('abc'), contentType: 'text/plain' }],
  tags: { category: 'onboarding' },
}

describe('provider requests (checked against each API’s documented contract)', () => {
  const capture = () => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) })
      return Response.json(url.includes('postmark') ? { MessageID: 'pm-1', ErrorCode: 0 } : { id: 're-1' })
    }) as typeof fetch
    return { seen, fetcher }
  }

  it('Resend: POST /emails with a Bearer key, base64 attachments, name/value tags', async () => {
    const { seen, fetcher } = capture()
    expect(await resendTransport({ apiKey: 're_test', fetch: fetcher }).send(fullMessage)).toEqual({ id: 're-1' })
    expect(seen[0]!.url).toBe('https://api.resend.com/emails')
    expect(seen[0]!.headers.authorization).toBe('Bearer re_test')
    expect(seen[0]!.body).toEqual({
      from: 'Caldera <hello@example.test>',
      to: ['Ann Lee <ann@example.test>'],
      cc: ['cc@example.test'],
      reply_to: ['support@example.test'],
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      headers: { 'X-Campaign': 'launch' },
      attachments: [{ filename: 'a.txt', content: 'YWJj', content_type: 'text/plain' }],
      tags: [{ name: 'category', value: 'onboarding' }],
    })
  })

  it('Postmark: POST /email with the server token header; ErrorCode != 0 is a refusal', async () => {
    const { seen, fetcher } = capture()
    expect(await postmarkTransport({ serverToken: 'pm-token', fetch: fetcher }).send(fullMessage)).toEqual({ id: 'pm-1' })
    expect(seen[0]!.url).toBe('https://api.postmarkapp.com/email')
    expect(seen[0]!.headers['x-postmark-server-token']).toBe('pm-token')
    expect(seen[0]!.body).toMatchObject({ From: 'Caldera <hello@example.test>', To: 'Ann Lee <ann@example.test>', Cc: 'cc@example.test', HtmlBody: '<p>Hi</p>', TextBody: 'Hi', Tag: 'onboarding', Metadata: { category: 'onboarding' }, Attachments: [{ Name: 'a.txt', Content: 'YWJj', ContentType: 'text/plain' }], MessageStream: 'outbound' })
    const refusing = postmarkTransport({ serverToken: 't', fetch: (async () => Response.json({ ErrorCode: 300, Message: 'Invalid To address' })) as never })
    await expect(refusing.send(fullMessage)).rejects.toThrow('postmark: Invalid To address')
  })

  it('SES v2: SendEmail with a valid SigV4 signature (re-computed by the test server)', async () => {
    const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret/key+value' }
    let checked: { body: any; signatureMatches: boolean } | undefined
    const server = new Hono().post('/v2/email/outbound-emails', async (c) => {
      const body = await c.req.text()
      // Sign the same request again with the same time: a wrong signature, header or body breaks the match.
      const resigned = await new AwsClient({ ...credentials, region: 'eu-west-1', service: 'ses' }).sign(c.req.url, {
        method: 'POST',
        headers: { 'content-type': c.req.header('content-type')!, accept: c.req.header('accept')! },
        body,
        aws: { datetime: c.req.header('x-amz-date')! },
      })
      checked = { body: JSON.parse(body), signatureMatches: resigned.headers.get('authorization') === c.req.header('authorization') }
      return c.json({ MessageId: 'ses-1' })
    })
    const { serve } = await import('@hono/node-server')
    const listener = serve({ fetch: server.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise((r) => listener.once('listening', r))
    const port = (listener.address() as { port: number }).port
    try {
      const result = await sesTransport({ region: 'eu-west-1', endpoint: `http://127.0.0.1:${port}`, ...credentials }).send(fullMessage)
      expect(result).toEqual({ id: 'ses-1' })
      expect(checked!.signatureMatches).toBe(true)
      expect(checked!.body).toMatchObject({
        FromEmailAddress: 'Caldera <hello@example.test>',
        Destination: { ToAddresses: ['Ann Lee <ann@example.test>'], CcAddresses: ['cc@example.test'] },
        Content: { Simple: { Subject: { Data: 'Hi' }, Body: { Html: { Data: '<p>Hi</p>' }, Text: { Data: 'Hi' } }, Attachments: [{ FileName: 'a.txt', RawContent: 'YWJj', ContentDisposition: 'ATTACHMENT' }] } },
        EmailTags: [{ Name: 'category', Value: 'onboarding' }],
      })
    } finally {
      listener.close()
    }
  })
})

describe('preview routes', () => {
  it('lists, renders and shows the outbox in development; nothing in production', async () => {
    const app = createApp({ env: defineEnv({}), providers: [mailProvider(() => ({ default: 'log', mailers: { log: { driver: 'memory' } }, from: 'hello@example.test' }), { mails: [WelcomeEmail, InvoiceEmail] })] })
    const make = (enabled: boolean) => new Hono().use(app.middleware()).route('/', mailPreviewRoutes({ enabled: () => enabled }))
    const dev = make(true)
    expect(await (await dev.request('/_caldera/mail')).text()).toContain('href="/_caldera/mail/users.welcome"')
    expect(await (await dev.request('/_caldera/mail/users.welcome')).text()).toContain('your account is ready')
    expect(await (await dev.request('/_caldera/mail/users.welcome?format=text')).text()).toContain('Hi Ann, your account is ready.')
    await app.services.mail.to('ann@example.test').send(WelcomeEmail, props)
    expect(await (await dev.request('/_caldera/mail/outbox')).text()).toContain('Welcome, Ann')
    expect((await make(false).request('/_caldera/mail')).status).toBe(404)
  })
})

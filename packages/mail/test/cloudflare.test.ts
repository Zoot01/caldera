import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cloudflareTransport, MailSendError, type Message } from '../src/index.js'

describe('Cloudflare Email Service on workerd (Miniflare)', () => {
  let mf: Miniflare
  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dirname, 'fixtures/cf-mail-worker.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      jsx: 'automatic',
      write: false,
      logLevel: 'silent',
    })
    mf = new Miniflare({
      modules: true,
      script: result.outputFiles[0]!.text,
      compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'],
      // Only these recipients may be sent to, as a real binding can be restricted.
      email: { send_email: [{ name: 'EMAIL', allowed_destination_addresses: ['ann@example.test'] }] },
    })
    await mf.ready
  }, 60_000)
  afterAll(async () => {
    await mf?.dispose()
  })

  it('renders React Email in the Worker and sends it through the send_email binding', async () => {
    const res = await mf.dispatchFetch('http://worker.test/')
    const body = (await res.json()) as { result?: { id?: string; mailer: string }; error?: string }
    expect(body.error).toBeUndefined()
    expect(body.result).toMatchObject({ mailer: 'cf', id: expect.any(String) })
  })

  it('surfaces the binding’s refusal as a non-retryable send error', async () => {
    const res = await mf.dispatchFetch('http://worker.test/?to=bob@example.test')
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/^cloudflare: /)
  })
})

describe('the structured message', () => {
  const message: Message = {
    from: { email: 'hello@example.test', name: 'App' },
    to: [{ email: 'ann@example.test' }],
    cc: [{ email: 'cc@example.test', name: 'C' }],
    bcc: [],
    replyTo: [{ email: 'reply@example.test' }],
    subject: 'Hi',
    html: '<p>Hi</p>',
    text: 'Hi',
    headers: { 'List-Unsubscribe': '<https://x.test/u>' },
    attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('hello'), contentType: 'text/plain' }],
    tags: { category: 'welcome' },
  }

  it('maps addresses, attachments (as base64) and tags (as X-Tag headers)', async () => {
    const sent: Record<string, unknown>[] = []
    const transport = cloudflareTransport({ send: async (m) => (sent.push(m), { messageId: 'm-1' }) })
    expect(await transport.send(message)).toEqual({ id: 'm-1' })
    expect(sent[0]).toEqual({
      from: { email: 'hello@example.test', name: 'App' },
      to: ['ann@example.test'],
      cc: [{ email: 'cc@example.test', name: 'C' }],
      replyTo: 'reply@example.test',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      headers: { 'List-Unsubscribe': '<https://x.test/u>', 'X-Tag-category': 'welcome' },
      attachments: [{ content: 'aGVsbG8=', filename: 'a.txt', type: 'text/plain', disposition: 'attachment' }],
    })
  })

  it('marks capacity errors retryable (failover moves on) and message errors not', async () => {
    const failing = (code: string) => cloudflareTransport({ send: async () => Promise.reject(Object.assign(new Error('nope'), { code })) })
    const limit = await failing('E_RATE_LIMIT_EXCEEDED').send(message).catch((e: MailSendError) => e)
    expect(limit).toBeInstanceOf(MailSendError)
    expect((limit as MailSendError).retryable).toBe(true)
    const unverified = await failing('E_SENDER_NOT_VERIFIED').send(message).catch((e: MailSendError) => e)
    expect((unverified as MailSendError).retryable).toBe(false)
    expect((unverified as MailSendError).message).toBe('cloudflare: E_SENDER_NOT_VERIFIED: nope')
    const many = { ...message, to: Array.from({ length: 51 }, (_, i) => ({ email: `u${i}@example.test` })) }
    await expect(cloudflareTransport({ send: async () => ({}) }).send(many)).rejects.toThrow(/at most 50 per message/)
  })
})

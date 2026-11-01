import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorHandler } from '../src/errors.js'
import { setUrlSigningKeys, signed, signedUrl, verifySignedUrl } from '../src/signed.js'

const KEY = 'k'.repeat(32)
const OLD = 'o'.repeat(32)

afterEach(() => {
  vi.useRealTimers()
  setUrlSigningKeys([])
})

describe('signed URLs', () => {
  it('signs a path or a full URL, and only those verify', async () => {
    setUrlSigningKeys([KEY])
    const path = await signedUrl('/unsubscribe/digest?user=42')
    expect(path).toMatch(/^\/unsubscribe\/digest\?user=42&signature=[\w-]+$/)
    expect(await verifySignedUrl(path)).toBe(true)
    // The host isn't signed: the same link works behind a proxy or another name.
    const full = await signedUrl('https://tracker.example/unsubscribe/digest?user=42')
    expect(full.startsWith('https://tracker.example/unsubscribe/digest?user=42&signature=')).toBe(true)
    expect(await verifySignedUrl(full.replace('tracker.example', 'localhost:3000'))).toBe(true)
    // Any change to the path or query breaks it.
    expect(await verifySignedUrl(path.replace('user=42', 'user=43'))).toBe(false)
    expect(await verifySignedUrl(path.replace('/digest', '/all'))).toBe(false)
    expect(await verifySignedUrl(`${path}&admin=1`)).toBe(false)
    expect(await verifySignedUrl('/unsubscribe/digest?user=42')).toBe(false)
    expect(await verifySignedUrl('/unsubscribe/digest?user=42&signature=%%%')).toBe(false)
  })

  it('expires', async () => {
    setUrlSigningKeys([KEY])
    vi.useFakeTimers({ now: new Date('2026-11-01T08:00:00Z') })
    const url = await signedUrl('/download?file=report', { expiresIn: '1h' })
    expect(await verifySignedUrl(url)).toBe(true)
    vi.setSystemTime(new Date('2026-11-01T09:00:01Z'))
    expect(await verifySignedUrl(url)).toBe(false)
    // The expiry is signed too: moving it doesn't help.
    expect(await verifySignedUrl(url.replace(/expires=\d+/, `expires=${Math.floor(Date.now() / 1000) + 3600}`))).toBe(false)
  })

  it('keeps links made with an earlier key working after a rotation', async () => {
    setUrlSigningKeys([OLD])
    const url = await signedUrl('/unsubscribe/digest?user=42')
    setUrlSigningKeys([KEY, OLD])
    expect(await verifySignedUrl(url)).toBe(true)
    setUrlSigningKeys([KEY])
    expect(await verifySignedUrl(url)).toBe(false)
  })

  it('needs a key', async () => {
    await expect(signedUrl('/x')).rejects.toMatchObject({ code: 'url_key_missing' })
  })

  it('refuses unsigned requests in signed() routes with a 403', async () => {
    setUrlSigningKeys([KEY])
    const app = new Hono().get('/unsubscribe', signed(), (c) => c.text('ok')).onError(errorHandler())
    expect(await (await app.request(await signedUrl('/unsubscribe?user=1'))).text()).toBe('ok')
    const refused = await app.request('/unsubscribe?user=1')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_signature' } })
  })
})

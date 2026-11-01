import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { isSecure, trustProxies } from '../src/index.js'

// What @hono/node-server gives a request: the socket it came in on.
const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })
const app = (proxies?: '*' | string[]) =>
  new Hono().use(trustProxies(proxies ? { proxies } : {})).get('/', (c) => c.json({ ip: (c.var as { ip?: string }).ip ?? null, secure: isSecure(c) }))
const ask = (server: Hono, peer: Record<string, unknown> | undefined, headers: Record<string, string>) =>
  Promise.resolve(server.request('/', { headers }, peer)).then((r) => r.json())

describe('trustProxies', () => {
  it('reads the client from a proxy on this machine, by default', async () => {
    expect(await ask(app(), from('127.0.0.1'), { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' })).toEqual({ ip: '203.0.113.7', secure: true })
    expect(await ask(app(), from('::ffff:127.0.0.1'), { 'x-forwarded-for': '203.0.113.7' })).toEqual({ ip: '203.0.113.7', secure: false })
  })

  it('ignores the headers from anyone else, who could write anything in them', async () => {
    expect(await ask(app(), from('198.51.100.1'), { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' })).toEqual({ ip: null, secure: false })
  })

  it('takes the last address no trusted proxy added: earlier ones came from the client', async () => {
    // The client claimed 10.0.0.1; the load balancer (10.1.1.1, trusted) heard from 203.0.113.7.
    const behind = app(['loopback', '10.1.1.1'])
    expect(await ask(behind, from('127.0.0.1'), { 'x-forwarded-for': '10.0.0.1, 203.0.113.7, 10.1.1.1' })).toMatchObject({ ip: '203.0.113.7' })
  })

  it("trusts a platform's own headers with '*', where there's no socket to check (Vercel)", async () => {
    expect(await ask(app('*'), undefined, { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' })).toEqual({ ip: '203.0.113.7', secure: true })
    expect(await ask(app(), undefined, { 'x-forwarded-for': '203.0.113.7' })).toEqual({ ip: null, secure: false })
  })
})

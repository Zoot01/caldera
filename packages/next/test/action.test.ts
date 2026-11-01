import { describe, expect, it } from 'vitest'
import { actionResult, parseSetCookie } from '../src/action.js'

describe('parseSetCookie', () => {
  it('reads the name, value and attributes cookies().set() takes', () => {
    expect(parseSetCookie('caldera_session=a%2Bb.c; Max-Age=7200; Path=/; HttpOnly; Secure; SameSite=Lax')).toEqual({
      name: 'caldera_session',
      value: 'a+b.c',
      maxAge: 7200,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    })
    expect(parseSetCookie('better-auth.session_token=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/')).toMatchObject({
      name: 'better-auth.session_token',
      value: '',
      expires: new Date(0),
    })
    expect(parseSetCookie('=nameless')).toBeUndefined()
  })
})

describe('actionResult', () => {
  it('gives validation errors one message per field', async () => {
    const body = { error: { code: 'validation_failed', message: 'The given data was invalid.', status: 422, fields: { email: ['Taken.', 'Other.'] } } }
    expect(await actionResult(Response.json(body, { status: 422 }))).toEqual({ ok: false, status: 422, errors: { email: 'Taken.' }, message: 'The given data was invalid.' })
  })

  it('passes JSON through, and other failures as a message', async () => {
    expect(await actionResult(Response.json({ saved: true }))).toEqual({ ok: true, status: 200, data: { saved: true } })
    expect(await actionResult(new Response(null, { status: 204 }))).toEqual({ ok: true, status: 204 })
    const limited = Response.json({ error: { code: 'rate_limited', message: 'Too many attempts.', status: 429 } }, { status: 429 })
    expect(await actionResult(limited)).toEqual({ ok: false, status: 429, message: 'Too many attempts.' })
  })
})

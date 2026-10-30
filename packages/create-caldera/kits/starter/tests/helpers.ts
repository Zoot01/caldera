import { createHmac } from 'node:crypto'
import type { TestApp } from '@caldera/testing'
import { User } from '../src/models/user.js'

export const PASSWORD = 'correct-horse-battery'

/** A user with a password, made through Better Auth (as registering does). */
export async function createUser(t: TestApp<any>, attributes: { name?: string; email?: string; password?: string } = {}) {
  const input = { name: 'Ann', email: 'ann@example.test', password: PASSWORD, ...attributes }
  await t.services.auth.api.signUpEmail({ body: input })
  return (await User.findFirst({ where: { email: input.email } }))!
}

/** The code an authenticator app shows for `key` (RFC 6238: 30-second steps, 6 digits, SHA-1). */
export function totp(key: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...key.replace(/=+$/, '').toUpperCase()].map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('')
  const secret = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const hmac = createHmac('sha1', secret).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0xf
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

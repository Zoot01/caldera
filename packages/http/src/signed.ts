import { CalderaError, parseDuration } from '@caldera-js/core'
import type { Context, MiddlewareHandler } from 'hono'
import { ForbiddenError } from './errors.js'

/**
 * Signed URLs, as Laravel's `URL::signedRoute`: a link that proves the app made it, for emails (an
 * unsubscribe link) and anything else that must work without a session. Signed with the session's
 * keys (APP_KEY first; earlier keys still verify, so rotating it keeps links working).
 */

const KEYS = Symbol.for('caldera.http.urlKeys')
const registry = globalThis as { [KEYS]?: Promise<CryptoKey[]> }
const encoder = new TextEncoder()

/** The keys URLs are signed and checked with. `sessionProvider` sets them from the session's `keys`. */
export function setUrlSigningKeys(secrets: readonly (string | undefined)[]) {
  const usable = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 32)
  registry[KEYS] = usable.length ? Promise.all(usable.map(derive)) : undefined
}

async function derive(secret: string) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('caldera'), info: encoder.encode('caldera:signed-url:v1') },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

async function keys(): Promise<CryptoKey[]> {
  const found = await registry[KEYS]
  if (!found?.length) throw new CalderaError('url_key_missing', 'Signed URLs need a key: add sessionProvider() to the app, with APP_KEY (at least 32 characters).')
  return found
}

// The path and query, without the signature and in a fixed order: the host isn't signed, so a link
// works through a proxy or another domain name for the same app.
function message(url: URL): Uint8Array<ArrayBuffer> {
  const params = [...url.searchParams].filter(([key]) => key !== 'signature').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return encoder.encode(`${url.pathname}?${new URLSearchParams(params)}`)
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
function unb64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/**
 * `url` with a signature (and, with `expiresIn`, an expiry) added to its query:
 * `await signedUrl(new URL('/unsubscribe/digest', appUrl), { expiresIn: '30d' })`.
 */
export async function signedUrl(url: string | URL, options: { expiresIn?: number | string } = {}): Promise<string> {
  const absolute = typeof url === 'string' && url.startsWith('/') ? null : new URL(url)
  const target = absolute ?? new URL(url, 'http://relative.invalid')
  target.searchParams.delete('signature')
  target.searchParams.delete('expires')
  if (options.expiresIn !== undefined) target.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + parseDuration(options.expiresIn)))
  const [key] = await keys()
  target.searchParams.set('signature', b64(new Uint8Array(await crypto.subtle.sign('HMAC', key!, message(target)))))
  return absolute ? target.toString() : `${target.pathname}${target.search}`
}

/** Whether `url` carries a signature this app made, not yet expired. */
export async function verifySignedUrl(url: string | URL): Promise<boolean> {
  const target = new URL(url, 'http://relative.invalid')
  const signature = target.searchParams.get('signature')
  if (!signature) return false
  const expires = target.searchParams.get('expires')
  if (expires !== null && !(Number(expires) >= Date.now() / 1000)) return false
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = unb64(signature)
  } catch {
    return false
  }
  for (const key of await keys()) if (await crypto.subtle.verify('HMAC', key, bytes, message(target))) return true
  return false
}

/** Whether this request's URL is signed (`signedUrl`) and fresh. */
export const hasValidSignature = (c: Context) => verifySignedUrl(c.req.url)

/** Route middleware: only signed, unexpired URLs get through; anything else is a 403. */
export function signed(): MiddlewareHandler {
  return async (c, next) => {
    if (!(await hasValidSignature(c))) throw new ForbiddenError('This link is invalid or has expired.', 'invalid_signature')
    await next()
  }
}

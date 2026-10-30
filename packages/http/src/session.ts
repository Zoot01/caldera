import { CalderaError, defineProvider, parseDuration, type RegisterContext } from '@caldera/core'

export { parseDuration }
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'

/**
 * Caldera's app session: flash messages, validation errors, old input and small app state.
 * Identity lives in Better Auth's own session; this one churns on every redirect, so it's a
 * cookie by default and costs no database write.
 */
export interface Session {
  get<T = unknown>(key: string): T | undefined
  get<T>(key: string, fallback: T): T
  has(key: string): boolean
  put(key: string, value: unknown): void
  /** Reads and removes a value. */
  pull<T = unknown>(key: string): T | undefined
  forget(key: string): void
  all(): Readonly<Record<string, unknown>>

  /** Available on the next request only. */
  flash(key: string, value: unknown): void
  /** Available for the rest of this request only. */
  now(key: string, value: unknown): void
  /** What the previous request flashed (plus anything set with `now`). */
  flashed(): Readonly<Record<string, unknown>>
  /** Keeps every flashed value for one more request, e.g. across a second redirect. */
  reflash(): void
  /** Keeps only these flashed values for one more request. */
  keep(...keys: string[]): void

  /** Validation errors flashed by the previous request, every message per field. */
  errors(bag?: string): Readonly<Record<string, string[]>>
  /** Names of the error bags flashed by the previous request (`default` unless a form named one). */
  errorBags(): string[]
  flashErrors(fields: Record<string, string[]>, bag?: string): void
  /** Input flashed after a failed plain-form submission, for refilling the form. */
  old<T = unknown>(key: string): T | undefined
  flashInput(input: Record<string, unknown>): void

  /** Call on sign-in and sign-out: keeps the data, issues a fresh cookie. */
  regenerate(): void
  /** Clears everything (sign-out). */
  invalidate(): void
  /** True once anything changed in this request, so it will be written. */
  readonly dirty: boolean
}

/** What's stored. Errors and old input are flash data, kept apart so `flashed()` is only the app's own. */
interface SessionRecord {
  data: Record<string, unknown>
  flash: Record<string, unknown>
  errors?: Record<string, Record<string, string[]>>
  old?: Record<string, unknown>
  /** Unix seconds after which the cookie is rejected, even if a client kept it. */
  exp?: number
}

export interface SessionOptions {
  /** `APP_KEY` first, then previous keys still accepted for reading (key rotation). */
  keys: readonly (string | undefined)[]
  cookie?: {
    name?: string
    sameSite?: 'lax' | 'strict' | 'none'
    /** `auto` sets Secure on https requests. */
    secure?: boolean | 'auto'
    path?: string
    domain?: string
    /** Browsers silently drop cookies over ~4KB, so larger sessions fail loudly instead. */
    maxBytes?: number
  }
  /** Seconds, or `'30m'`, `'2h'`, `'7d'`. Default 2h. */
  lifetime?: number | string
}

const DEFAULTS = { name: 'caldera_session', sameSite: 'lax', secure: 'auto', path: '/', maxBytes: 3800 } as const

/**
 * Registers the session settings. Add `startSession()` to the HTTP app to load and save it per
 * request; `c.var.session` is typed either way.
 */
export function sessionProvider(resolve: (app: RegisterContext<unknown>) => SessionOptions) {
  return defineProvider({
    name: 'session',
    register: (app) => ({ sessionCodec: app.singleton(() => createSessionCodec(resolve(app))) }),
    request: {
      // Replaced by startSession(); this stand-in explains what's missing instead of failing vaguely.
      session: (): Session => notStarted,
    },
  })
}

/**
 * Loads the session from its cookie before the request and writes it after, only when something
 * changed. An empty session sets no cookie, so anonymous pages stay cacheable.
 */
export function startSession(): MiddlewareHandler {
  return async (c, next) => {
    const codec = (c.var as { sessionCodec?: SessionCodec }).sessionCodec
    if (!codec) throw new CalderaError('session_not_configured', 'startSession() needs sessionProvider() in the app.')
    const incoming = getCookie(c, codec.cookieName)
    const record = incoming ? await codec.decode(incoming) : null
    const session = createSession(record)
    c.set('session' as never, session as never)
    await next()

    const outgoing = session.toRecord()
    let header: string | undefined
    if (isEmpty(outgoing)) {
      if (incoming) header = codec.expire(c)
    } else if (session.dirty || !incoming || record === null || codec.needsRefresh(record)) {
      header = await codec.encode(c, outgoing)
    }
    if (header) appendHeader(c, 'set-cookie', header)
  }
}

/** The session for this request, or a clear error when `startSession()` isn't installed. */
export function sessionOf(c: Context): Session {
  return (c.var as { session?: Session }).session ?? notStarted
}

/** True when `startSession()` has loaded a real session for this request. */
export function isSessionStarted(c: Context): boolean {
  const session = (c.var as { session?: Session }).session
  return session !== undefined && session !== notStarted
}

// --- in-memory session -----------------------------------------------------------------------

interface InternalSession extends Session {
  toRecord(): SessionRecord
}

export function createSession(record: SessionRecord | null): InternalSession {
  const data: Record<string, unknown> = { ...record?.data }
  // Pull-on-read: the previous request's flash is this request's to read, and gone after it.
  const current: Record<string, unknown> = { ...record?.flash }
  const currentErrors = record?.errors ?? {}
  const currentOld = record?.old ?? {}
  let next: Record<string, unknown> = {}
  let nextErrors: Record<string, Record<string, string[]>> | undefined
  let nextOld: Record<string, unknown> | undefined
  // Reading a flash-only session still consumes it, which changes what must be stored.
  let dirty = Boolean(record && (Object.keys(current).length || record.errors || record.old))
  const touch = () => {
    dirty = true
  }

  return {
    get(key: string, fallback?: unknown) {
      return (key in data ? data[key] : fallback) as never
    },
    has: (key) => key in data && data[key] !== undefined,
    put(key, value) {
      data[key] = value
      touch()
    },
    pull(key) {
      const value = data[key]
      if (key in data) {
        delete data[key]
        touch()
      }
      return value as never
    },
    forget(key) {
      if (key in data) {
        delete data[key]
        touch()
      }
    },
    all: () => data,

    flash(key, value) {
      next[key] = value
      touch()
    },
    now(key, value) {
      current[key] = value
    },
    flashed: () => current,
    reflash() {
      next = { ...current, ...next }
      nextErrors ??= Object.keys(currentErrors).length ? currentErrors : undefined
      nextOld ??= Object.keys(currentOld).length ? currentOld : undefined
      touch()
    },
    keep(...keys) {
      for (const key of keys) if (key in current && !(key in next)) next[key] = current[key]
      touch()
    },

    errors: (bag = 'default') => currentErrors[bag] ?? {},
    errorBags: () => Object.keys(currentErrors),
    flashErrors(fields, bag = 'default') {
      nextErrors = { ...nextErrors, [bag]: fields }
      touch()
    },
    old: (key) => getPath(currentOld, key) as never,
    flashInput(input) {
      nextOld = withoutSecrets(input)
      touch()
    },

    regenerate: touch,
    invalidate() {
      for (const key of Object.keys(data)) delete data[key]
      next = {}
      nextErrors = undefined
      nextOld = undefined
      touch()
    },
    get dirty() {
      return dirty
    },

    toRecord() {
      return {
        data,
        flash: next,
        ...(nextErrors ? { errors: nextErrors } : {}),
        ...(nextOld ? { old: nextOld } : {}),
      }
    },
  }
}

const notStarted: Session = new Proxy({} as Session, {
  get(_target, key) {
    if (key === 'dirty') return false
    if (typeof key === 'symbol' || key === 'then') return undefined
    throw new CalderaError('session_not_started', `c.var.session.${key}() needs startSession() in the HTTP app (after app.middleware()).`)
  },
})

function isEmpty(record: SessionRecord): boolean {
  return Object.keys(record.data).length === 0 && Object.keys(record.flash).length === 0 && !record.errors && !record.old
}

/** Never flash passwords or uploads back into a cookie. */
function withoutSecrets(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (/^password|_confirmation$|token$/i.test(key)) continue
    if (typeof File !== 'undefined' && value instanceof File) continue
    out[key] = value
  }
  return out
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  if (path in source) return source[path]
  let value: unknown = source
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

// --- encrypted cookie --------------------------------------------------------------------------

export interface SessionCodec {
  readonly cookieName: string
  decode(value: string): Promise<SessionRecord | null>
  /** The Set-Cookie header for this record. Drops old input first if it doesn't fit. */
  encode(c: Context, record: SessionRecord): Promise<string>
  expire(c: Context): string
  /** True when the cookie is past half its lifetime, so a read-only request still extends it. */
  needsRefresh(record: SessionRecord): boolean
}

const VERSION = 1
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * AES-256-GCM with a key derived from APP_KEY by HKDF (Web Crypto, so it runs on every runtime).
 * The cookie name is authenticated as additional data: a value can't be moved to another cookie.
 */
export function createSessionCodec(options: SessionOptions): SessionCodec {
  const cookie = { ...DEFAULTS, ...options.cookie }
  const lifetime = parseDuration(options.lifetime ?? '2h')
  const secrets = options.keys.filter((k): k is string => typeof k === 'string' && k.length > 0)
  if (secrets.length === 0) throw new CalderaError('session_key_missing', 'The session needs a key: set APP_KEY.')
  let keys: Promise<CryptoKey[]> | undefined
  const derived = () => (keys ??= Promise.all(secrets.map(deriveKey)))
  const aad = encoder.encode(cookie.name)

  const attributes = (c: Context, maxAge: number) => ({
    path: cookie.path,
    httpOnly: true,
    sameSite: (cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)) as 'Lax' | 'Strict' | 'None',
    secure: cookie.secure === 'auto' ? new URL(c.req.url).protocol === 'https:' : cookie.secure,
    maxAge,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
  })

  const seal = async (record: SessionRecord) => {
    const [key] = await derived()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = encoder.encode(JSON.stringify(record))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key!, plaintext))
    const out = new Uint8Array(1 + iv.length + sealed.length)
    out[0] = VERSION
    out.set(iv, 1)
    out.set(sealed, 1 + iv.length)
    return toBase64Url(out)
  }

  return {
    cookieName: cookie.name,

    async decode(value) {
      const bytes = fromBase64Url(value)
      if (!bytes || bytes.length < 1 + 12 + 16 || bytes[0] !== VERSION) return null
      const iv = bytes.subarray(1, 13)
      const sealed = bytes.subarray(13)
      // The current key first, then previous ones, so rotating APP_KEY doesn't sign everyone out.
      for (const key of await derived()) {
        try {
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, sealed)
          const record = JSON.parse(decoder.decode(plain)) as SessionRecord
          if (record.exp !== undefined && record.exp < Date.now() / 1000) return null
          return record
        } catch {
          // Wrong key or tampered: try the next key.
        }
      }
      return null
    },

    async encode(c, record) {
      const stamped = { ...record, exp: Math.floor(Date.now() / 1000) + lifetime }
      let header = serialize(cookie.name, await seal(stamped), attributes(c, lifetime))
      if (header.length > cookie.maxBytes && stamped.old) {
        const { old: _dropped, ...rest } = stamped
        header = serialize(cookie.name, await seal(rest), attributes(c, lifetime))
      }
      if (header.length > cookie.maxBytes) {
        throw new CalderaError(
          'session_too_large',
          `The session cookie is ${header.length} bytes, over the ${cookie.maxBytes}-byte limit (browsers drop cookies over ~4KB). Store less in the session, or use a server-side session driver.`,
          { bytes: header.length, maxBytes: cookie.maxBytes },
        )
      }
      return header
    },

    expire: (c) => serialize(cookie.name, '', attributes(c, 0)),

    needsRefresh: (record) => record.exp !== undefined && record.exp - Date.now() / 1000 < lifetime / 2,
  }
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('caldera'), info: encoder.encode('caldera:session:v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
}

/** Appends a header even to responses whose headers are immutable (e.g. from `fetch` or `Response.redirect`). */
export function appendHeader(c: Context, name: string, value: string) {
  try {
    c.res.headers.append(name, value)
  } catch {
    c.res = new Response(c.res.body, c.res)
    c.res.headers.append(name, value)
  }
}

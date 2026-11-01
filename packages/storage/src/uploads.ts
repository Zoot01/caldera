import { CalderaError, parseDuration, type Duration } from '@caldera-js/core'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { type Disk, FileNotFoundError } from './disk.js'
import { defaultStorage } from './files.js'
import type { SignedUpload } from './driver.js'
import { inspectFile, INSPECT_BYTES, parseSize, type ZFileOptions } from './zfile.js'

/** A stored file, as a model column keeps it (`zjsonb(fileRef)` / `zjson(fileRef)`). */
export const fileRef = z.object({
  disk: z.string(),
  key: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  /** The name the user's file had, for downloads. Never used as a storage key. */
  name: z.string(),
})
export type FileRef = z.infer<typeof fileRef>

/**
 * A checked direct upload, as `/_caldera/uploads/complete` answers it: the file waits under
 * `tmp/uploads/`, and the ref is signed with the app's key. A form sends it back, `zupload(name)`
 * checks it, and `claimUpload(file)` moves the file into place (once) and gives the FileRef to store.
 * It has no `key`, so it can't be stored by mistake before it's claimed. A type, not an interface:
 * Inertia's router and useForm only take data whose type has an index signature, which interfaces lack.
 */
export type PendingUpload = {
  upload: string
  disk: string
  /** Where the file waits until it's claimed (under `tmp/uploads/`). */
  pending: string
  /** Where claiming puts it: the upload's directory. */
  directory: string
  size: number
  mime: string
  name: string
  exp: number
  signature: string
}

export interface UploadDefinition {
  readonly kind: 'caldera.upload'
  readonly name: string
  readonly rules: ZFileOptions
  /** Where accepted files go, e.g. `avatars`. */
  readonly directory: string
  /** The disk (default: the default disk). It needs presigned uploads, e.g. s3, or local with `serve`. */
  readonly disk: string | undefined
  readonly authorize: ((c: Context, file: { name: string; size: number; type: string }) => boolean | Promise<boolean>) | undefined
  readonly expiresIn: number
}

/**
 * One kind of direct upload, e.g. avatars: its rules (the same as zfile()), where files go, and who
 * may upload. `uploadRoutes({ uploads: [...] })` serves them; `useUpload('avatar')` uploads to them.
 */
export function defineUpload(
  name: string,
  options: { rules: ZFileOptions; directory: string; disk?: string; authorize?: UploadDefinition['authorize']; expiresIn?: Duration },
): UploadDefinition {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new CalderaError('upload_name_invalid', `Upload name "${name}" should be a stable id like "avatar".`)
  if (options.rules.maxSize === undefined) throw new CalderaError('upload_needs_max_size', `Upload "${name}" needs rules.maxSize: a presigned upload has to declare its limit.`)
  return { kind: 'caldera.upload', name, rules: options.rules, directory: options.directory, disk: options.disk, authorize: options.authorize, expiresIn: parseDuration(options.expiresIn ?? '15m') }
}

interface StorageLike {
  disk(name: string): Disk
  readonly name: string
}

interface UploadClaims {
  upload: string
  key: string
  size: number
  type: string
  name: string
  user: string | null
  exp: number
}

const encoder = new TextEncoder()
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const unb64 = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

async function hmacKey(secret: string, info = 'caldera:uploads:v1') {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('caldera'), info: encoder.encode(info) }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
}

const SECRET = Symbol.for('caldera.storage.uploadSecret')
const registry = globalThis as { [SECRET]?: string }

/** The key upload tokens and refs are signed with (set by `storageProvider` from `uploadSecret`). */
export function setUploadSecret(secret: string | undefined) {
  registry[SECRET] = secret
}

const refKeys = new Map<string, Promise<CryptoKey>>()
function refKey(secret: string) {
  if (secret.length < 32) throw new CalderaError('upload_secret_short', 'Uploads need a secret of at least 32 characters (storage.uploadSecret: env.APP_KEY).')
  let key = refKeys.get(secret)
  if (!key) refKeys.set(secret, (key = hmacKey(secret, 'caldera:uploads:ref:v1')))
  return key
}
const refMessage = (ref: Omit<PendingUpload, 'signature'>) => encoder.encode(JSON.stringify([ref.upload, ref.exp, ref.disk, ref.pending, ref.directory, ref.size, ref.mime, ref.name]))

/** How long a completed upload can be submitted with a form (well under pruneUploads' default day). */
const REF_LIFETIME = 12 * 60 * 60

async function signRef(secret: string, ref: Omit<PendingUpload, 'exp' | 'signature'>): Promise<PendingUpload> {
  const unsigned = { ...ref, exp: Math.floor(Date.now() / 1000) + REF_LIFETIME }
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await refKey(secret), refMessage(unsigned))))
  return { ...unsigned, signature }
}

/** Whether a pending upload is one this app signed, of the kind `upload`, and still fresh. */
async function verifyRef(ref: PendingUpload, upload: string): Promise<boolean> {
  const secret = registry[SECRET]
  if (!secret) throw new CalderaError('upload_secret_missing', 'Direct uploads need storage.uploadSecret (env.APP_KEY) in the storage config.')
  const { signature, ...unsigned } = ref
  let bytes: Uint8Array
  try {
    bytes = unb64(signature)
  } catch {
    return false
  }
  const valid = await crypto.subtle.verify('HMAC', await refKey(secret), bytes as Uint8Array<ArrayBuffer>, refMessage(unsigned))
  return valid && ref.upload === upload && ref.exp >= Date.now() / 1000 && ref.pending.startsWith('tmp/uploads/')
}

const pendingSchema = z.object(
  { upload: z.string(), disk: z.string(), pending: z.string(), directory: z.string(), size: z.number(), mime: z.string(), name: z.string(), exp: z.number(), signature: z.string() },
  { error: 'Upload a file.' },
)
const INVALID = 'This upload is invalid or has expired. Upload the file again.'

/**
 * A Zod schema for a file uploaded with `useUpload(name)`: checks the ref's signature, that it was
 * an upload of this kind, and that it hasn't expired. It has no side effects, so a form that fails
 * on another field can be sent again with the same file. Store the file with `claimUpload(file)`.
 * Never accept a FileRef from the browser instead: its disk and key would be whatever was sent.
 * Takes the ref as an object (a JSON body) or a JSON string (a multipart form). Async, like zfile().
 */
export function zupload(upload: string | UploadDefinition): z.ZodType<PendingUpload, unknown> {
  const name = typeof upload === 'string' ? upload : upload.name
  return z
    .preprocess((value) => {
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }, pendingSchema)
    .superRefine(async (ref, ctx) => {
      if (!(await verifyRef(ref, name))) ctx.addIssue({ code: 'custom', message: INVALID })
    }) as unknown as z.ZodType<PendingUpload, unknown>
}

/**
 * Moves a pending upload (from `zupload`) into its directory under a new random name, and returns
 * the FileRef to store: `avatar: await claimUpload(form.avatar)`. Each upload is claimed once, so
 * two rows never share a file (deleting one would delete the other's). Claiming it again, or after
 * it expired, throws a validation error on `field` (default: the upload's name).
 */
export async function claimUpload(file: PendingUpload, options: { field?: string; storage?: { disk(name: string): Disk } } = {}): Promise<FileRef> {
  const refused = () => new CalderaError('validation_failed', USED, { fields: { [options.field ?? file.upload]: [USED] } })
  if (!(await verifyRef(file, file.upload))) throw refused()
  const disk = (options.storage ?? defaultStorage()).disk(file.disk)
  const key = `${file.directory.replace(/\/$/, '')}/${randomName()}${/\.[a-z0-9]+$/i.exec(file.pending)?.[0] ?? ''}`
  try {
    await disk.move(file.pending, key)
  } catch (error) {
    // Claimed already (or pruned): the pending file is gone.
    if (error instanceof FileNotFoundError) throw refused()
    throw error
  }
  return { disk: file.disk, key, size: file.size, mime: file.mime, name: file.name }
}
const USED = 'This upload was already used or has expired. Upload the file again.'

const startSchema = z.object({ upload: z.string(), name: z.string().min(1).max(255), size: z.number().int().positive(), type: z.string().min(1).max(255) })
const completeSchema = z.object({ token: z.string().min(1) })

/**
 * Direct-to-bucket uploads (required on Vercel, whose functions take 4.5MB bodies at most). Stateless:
 * 1. POST `/_caldera/uploads` `{ upload, name, size, type }`: checks the declared file against the
 *    upload's rules and `authorize`, and answers a presigned PUT (type and size signed in) for a
 *    `tmp/uploads/` key, plus a token signed with your key (bound to the user, the key and the size).
 * 2. The browser PUTs the file straight to the bucket.
 * 3. POST `/_caldera/uploads/complete` `{ token }`: checks the stored size and sniffs the real bytes
 *    with the same rules. Answers a signed `PendingUpload`: the form that stores it validates it with
 *    `zupload(name)` and moves it into the upload's directory with `claimUpload(file)`.
 * A refused file is deleted. `pruneUploads()` removes ones never completed or never claimed. The
 * secret defaults to the storage config's `uploadSecret`.
 */
export function uploadRoutes(options: { uploads: readonly UploadDefinition[]; secret?: (c: Context) => string; path?: string }): Hono {
  const base = options.path ?? '/_caldera/uploads'
  const byName = new Map(options.uploads.map((u) => [u.name, u]))
  const keys = new Map<string, Promise<CryptoKey>>()
  const secretOf = (c: Context) => {
    const secret = options.secret ? options.secret(c) : registry[SECRET]
    if (!secret) throw new CalderaError('upload_secret_missing', 'uploadRoutes needs storage.uploadSecret (env.APP_KEY) in the storage config, or a `secret`.')
    return secret
  }
  const keyFor = (secret: string) => {
    if (secret.length < 32) throw new CalderaError('upload_secret_short', 'uploadRoutes needs a secret of at least 32 characters (use APP_KEY).')
    let key = keys.get(secret)
    if (!key) keys.set(secret, (key = hmacKey(secret)))
    return key
  }
  const userOf = (c: Context) => {
    const user = (c.var as { user?: { id?: unknown } | null }).user
    return user?.id === undefined || user.id === null ? null : String(user.id)
  }
  const storageOf = (c: Context) => {
    const storage = (c.var as { storage?: StorageLike }).storage
    if (!storage) throw new CalderaError('storage_not_configured', 'uploadRoutes needs storageProvider() in the app.')
    return storage
  }
  const refuse = (c: Context, status: 400 | 403 | 422, code: string, message: string) => c.json({ error: { code, message, status, ...(status === 422 ? { fields: { file: [message] } } : {}) } }, status)

  return new Hono()
    .post(base, async (c) => {
      const parsed = startSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return refuse(c, 400, 'bad_request', 'Send { upload, name, size, type }.')
      const { upload: uploadName, name, size, type } = parsed.data
      const upload = byName.get(uploadName)
      if (!upload) return refuse(c, 400, 'upload_unknown', `No upload named "${uploadName}".`)
      if (upload.authorize && !(await upload.authorize(c, { name, size, type }))) return refuse(c, 403, 'forbidden', 'You can’t upload this.')
      // The declared size and type are checked now (cheaply); the bytes are checked on completion.
      const max = parseSize(upload.rules.maxSize!)
      if (size > max) return refuse(c, 422, 'validation_failed', `The file is too large; the limit is ${Math.round(max / 1024)}KB.`)
      const storage = storageOf(c)
      const disk = upload.disk ? storage.disk(upload.disk) : storage.disk(storage.name)
      const key = `tmp/uploads/${crypto.randomUUID()}`
      const signed: SignedUpload = await disk.temporaryUploadUrl(key, { expiresIn: upload.expiresIn, contentType: type, contentLength: size })
      const claims: UploadClaims = { upload: upload.name, key, size, type, name, user: userOf(c), exp: Math.floor(Date.now() / 1000) + upload.expiresIn + 300 }
      const payload = b64(encoder.encode(JSON.stringify(claims)))
      const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(secretOf(c)), encoder.encode(payload))))
      return c.json({ upload: signed, token: `${payload}.${signature}` })
    })
    .post(`${base}/complete`, async (c) => {
      const parsed = completeSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return refuse(c, 400, 'bad_request', 'Send { token }.')
      const [payload, signature] = parsed.data.token.split('.')
      let claims: UploadClaims
      try {
        const valid = await crypto.subtle.verify('HMAC', await keyFor(secretOf(c)), unb64(signature ?? '') as Uint8Array<ArrayBuffer>, encoder.encode(payload ?? ''))
        if (!valid) throw new Error('signature')
        claims = JSON.parse(new TextDecoder().decode(unb64(payload!))) as UploadClaims
      } catch {
        return refuse(c, 403, 'forbidden', 'This upload is invalid or has expired.')
      }
      if (claims.exp < Date.now() / 1000 || claims.user !== userOf(c)) return refuse(c, 403, 'forbidden', 'This upload is invalid or has expired.')
      const upload = byName.get(claims.upload)
      if (!upload) return refuse(c, 400, 'upload_unknown', `No upload named "${claims.upload}".`)
      const storage = storageOf(c)
      const disk = upload.disk ? storage.disk(upload.disk) : storage.disk(storage.name)
      const info = await disk.info(claims.key).catch(() => undefined)
      // Gone already: completed before (a token works once), or never uploaded.
      if (!info) return refuse(c, 400, 'upload_missing', 'Nothing was uploaded for this token (or it was already completed).')
      const reject = async (message: string) => {
        await disk.delete(claims.key)
        return refuse(c, 422, 'validation_failed', message)
      }
      if (info.size !== claims.size) return reject('The uploaded file isn’t the size that was declared.')
      const head = new Uint8Array(await new Response(await disk.getStream(claims.key, { start: 0, end: Math.min(info.size, INSPECT_BYTES) - 1 })).arrayBuffer())
      const result = await inspectFile(head, info.size, upload.rules)
      if (!result.ok) return reject(result.message)
      // Checked: it waits under a new name until a form claims it (unclaimed ones are pruned).
      const pending = `tmp/uploads/${randomName()}.${result.detected.ext}`
      await disk.move(claims.key, pending)
      const ref = { upload: upload.name, disk: disk.name, pending, directory: upload.directory.replace(/\/$/, ''), size: info.size, mime: result.detected.mime, name: claims.name }
      // Signed with the key zupload() checks: the storage config's, even when `secret` is given.
      return c.json({ file: await signRef(registry[SECRET] ?? secretOf(c), ref), detected: result.detected })
    })
}

/** Deletes uploads never completed or never claimed (older than `olderThan` under `tmp/uploads/`). Schedule it daily. */
export async function pruneUploads(disk: Disk, options: { olderThan?: Duration } = {}): Promise<number> {
  const cutoff = Date.now() - parseDuration(options.olderThan ?? '1d') * 1000
  let removed = 0
  for await (const file of disk.listAll('tmp/uploads')) {
    if (!file.lastModified || file.lastModified.getTime() <= cutoff) {
      await disk.delete(file.key)
      removed++
    }
  }
  return removed
}

function randomName(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

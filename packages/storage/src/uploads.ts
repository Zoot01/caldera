import { CalderaError, parseDuration, type Duration } from '@caldera/core'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { Disk } from './disk.js'
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
 * A FileRef as `/_caldera/uploads/complete` answers it: signed with the app's key, so the server that
 * stores it can tell it came from a completed upload of that kind (`zupload('avatar')` checks).
 */
export type SignedFileRef = FileRef & { upload: string; exp: number; signature: string }

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
const refMessage = (ref: Omit<SignedFileRef, 'signature'>) => encoder.encode(JSON.stringify([ref.upload, ref.exp, ref.disk, ref.key, ref.size, ref.mime, ref.name]))

/** How long a completed upload's ref can be submitted with a form. */
const REF_LIFETIME = 24 * 60 * 60

async function signRef(secret: string, upload: string, ref: FileRef): Promise<SignedFileRef> {
  const unsigned = { ...ref, upload, exp: Math.floor(Date.now() / 1000) + REF_LIFETIME }
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await refKey(secret), refMessage(unsigned))))
  return { ...unsigned, signature }
}

const signedRefSchema = z.object({ ...fileRef.shape, upload: z.string(), exp: z.number(), signature: z.string() }, { error: 'Upload a file.' })

/**
 * A Zod schema for a file uploaded with `useUpload(name)`: checks the ref's signature, that it was
 * an upload of this kind, and that it hasn't expired, then gives the plain FileRef to store. Never
 * accept a FileRef from the browser any other way: its disk and key would be whatever was sent.
 * Takes the ref as an object (a JSON body) or a JSON string (a multipart form). Async, like zfile().
 */
export function zupload(upload: string | UploadDefinition): z.ZodType<FileRef, unknown> {
  const name = typeof upload === 'string' ? upload : upload.name
  const invalid = 'This upload is invalid or has expired. Upload the file again.'
  return z
    .preprocess((value) => {
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }, signedRefSchema)
    .superRefine(async (ref, ctx) => {
      const secret = registry[SECRET]
      if (!secret) throw new CalderaError('upload_secret_missing', 'zupload() needs storage.uploadSecret (env.APP_KEY) in the storage config.')
      const { signature, ...unsigned } = ref
      let bytes: Uint8Array
      try {
        bytes = unb64(signature)
      } catch {
        return void ctx.addIssue({ code: 'custom', message: invalid })
      }
      const valid = await crypto.subtle.verify('HMAC', await refKey(secret), bytes as Uint8Array<ArrayBuffer>, refMessage(unsigned))
      if (!valid || ref.upload !== name || ref.exp < Date.now() / 1000) ctx.addIssue({ code: 'custom', message: invalid })
    })
    .transform(({ disk, key, size, mime, name: fileName }): FileRef => ({ disk, key, size, mime, name: fileName })) as unknown as z.ZodType<FileRef, unknown>
}

const startSchema = z.object({ upload: z.string(), name: z.string().min(1).max(255), size: z.number().int().positive(), type: z.string().min(1).max(255) })
const completeSchema = z.object({ token: z.string().min(1) })

/**
 * Direct-to-bucket uploads (required on Vercel, whose functions take 4.5MB bodies at most). Stateless:
 * 1. POST `/_caldera/uploads` `{ upload, name, size, type }`: checks the declared file against the
 *    upload's rules and `authorize`, and answers a presigned PUT (type and size signed in) for a
 *    `tmp/uploads/` key, plus a token signed with your key (bound to the user, the key and the size).
 * 2. The browser PUTs the file straight to the bucket.
 * 3. POST `/_caldera/uploads/complete` `{ token }`: checks the stored size, sniffs the real bytes with
 *    the same rules, and moves the file to its directory under a random name. Answers the FileRef,
 *    signed: the form that stores it validates it with `zupload(name)`.
 * A refused file is deleted. `pruneUploads()` removes ones never completed. The secret defaults to
 * the storage config's `uploadSecret`.
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
      const finalKey = `${upload.directory.replace(/\/$/, '')}/${randomName()}.${result.detected.ext}`
      await disk.move(claims.key, finalKey)
      const ref: FileRef = { disk: disk.name, key: finalKey, size: info.size, mime: result.detected.mime, name: claims.name }
      // Signed with the key zupload() checks: the storage config's, even when `secret` is given.
      return c.json({ file: await signRef(registry[SECRET] ?? secretOf(c), upload.name, ref), detected: result.detected })
    })
}

/** Deletes uploads that were never completed (older than `olderThan` under `tmp/uploads/`). Schedule it daily. */
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

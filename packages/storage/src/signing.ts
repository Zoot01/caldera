/**
 * HMAC-signed URLs for disks without a native signer (local, memory in development): what Laravel's
 * `serve: true` local disks do. The signature binds the method, disk, key, expiry and (for uploads)
 * the exact content type and size, so a URL can't be reused for anything else.
 */
export interface UrlSigner {
  sign(fields: SignedFields): Promise<string>
  verify(fields: SignedFields, signature: string): Promise<boolean>
}

export interface SignedFields {
  method: 'GET' | 'PUT'
  disk: string
  key: string
  /** Epoch seconds. */
  expires: number
  contentType?: string
  contentLength?: number
  downloadAs?: string
}

const encoder = new TextEncoder()

export function createUrlSigner(secret: string): UrlSigner {
  let key: Promise<CryptoKey> | undefined
  const hmacKey = () =>
    (key ??= (async () => {
      const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('caldera'), info: encoder.encode('caldera:storage:v1') },
        material,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      )
    })())
  const message = (f: SignedFields) => encoder.encode([f.method, f.disk, f.key, f.expires, f.contentType ?? '', f.contentLength ?? '', f.downloadAs ?? ''].join('\n'))
  return {
    async sign(fields) {
      const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), message(fields)))
      return btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    },
    async verify(fields, signature) {
      if (fields.expires < Date.now() / 1000) return false
      let bytes: Uint8Array
      try {
        bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
      } catch {
        return false
      }
      // crypto.subtle.verify compares in constant time.
      return crypto.subtle.verify('HMAC', await hmacKey(), bytes as Uint8Array<ArrayBuffer>, message(fields))
    },
  }
}

export const SIGNED_ROUTE_PREFIX = '/_caldera/storage'

/**
 * The signed URL for a file on a disk served by `storageRoutes()`. Without `baseUrl` it's relative
 * (`/_caldera/storage/...`), so it works on whatever origin the page was loaded from.
 */
export async function signedRouteUrl(signer: UrlSigner, baseUrl: string | undefined, fields: SignedFields): Promise<string> {
  const url = new URL(`${SIGNED_ROUTE_PREFIX}/${encodeURIComponent(fields.disk)}/${fields.key.split('/').map(encodeURIComponent).join('/')}`, baseUrl ?? 'http://relative.invalid')
  url.searchParams.set('expires', String(fields.expires))
  if (fields.downloadAs) url.searchParams.set('download', fields.downloadAs)
  url.searchParams.set('signature', await signer.sign(fields))
  return baseUrl ? url.toString() : `${url.pathname}${url.search}`
}

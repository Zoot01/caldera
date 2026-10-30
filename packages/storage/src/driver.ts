/** What a stored file is, as drivers report it. */
export interface FileInfo {
  key: string
  size: number
  contentType: string | undefined
  /** Opaque version marker (S3 ETag, a hash). */
  etag: string | undefined
  lastModified: Date | undefined
}

export interface PutOptions {
  contentType?: string
  /** Overrides the disk's default. Ignored (with an error) on disks without per-file visibility. */
  visibility?: 'public' | 'private'
  cacheControl?: string
  /** `Content-Disposition` stored with the object, e.g. `attachment; filename="report.pdf"`. */
  contentDisposition?: string
}

export interface SignedUrlOptions {
  /** Seconds. */
  expiresIn: number
  /** Served as an attachment (download) with this file name. */
  downloadAs?: string
}

export interface SignedUpload {
  url: string
  method: 'PUT'
  /**
   * Send these headers with the upload (they're signed). The size is signed too: the body must be
   * exactly the declared length, which the browser sends as Content-Length on its own.
   */
  headers: Record<string, string>
  expiresAt: string
}

/**
 * A storage backend: raw operations on normalised keys and web types. Disks add key safety, body
 * conversion, errors and capabilities on top, once for every driver.
 */
export interface StorageDriver {
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, options: PutOptions & { size?: number }): Promise<void>
  /** null when the file doesn't exist. `range` is inclusive bytes. */
  get(key: string, range?: { start: number; end?: number }): Promise<{ body: ReadableStream<Uint8Array>; info: FileInfo } | null>
  head(key: string): Promise<FileInfo | null>
  delete(key: string): Promise<void>
  /** One page of files under a prefix (recursively), sorted by key. */
  list(prefix: string, options: { cursor?: string; limit: number }): Promise<{ files: FileInfo[]; cursor: string | undefined }>
  copy?(from: string, to: string): Promise<void>
  /** The permanent public URL, on disks with public files. */
  url?(key: string): string
  signedUrl?(key: string, options: SignedUrlOptions): Promise<string>
  signedUpload?(key: string, options: { expiresIn: number; contentType: string; contentLength: number }): Promise<SignedUpload>
  /** For disks whose signed URLs Caldera serves itself (`storageRoutes()`). */
  verifySignature?(fields: import('./signing.js').SignedFields, signature: string): Promise<boolean>
  close?(): Promise<void>
}

export interface StorageCapabilities {
  /** Permanent public URLs (`url()`). */
  publicUrls: boolean
  /** Expiring download URLs (`temporaryUrl()`). */
  signedUrls: boolean
  /** Expiring upload URLs the browser PUTs to (`temporaryUploadUrl()`). */
  presignedUploads: boolean
  /** Per-file public/private. False on R2 (no object ACLs). */
  visibility: boolean
  /** Byte-range reads. */
  rangeReads: boolean
}

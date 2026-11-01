import { CalderaError } from '@caldera-js/core'

/**
 * Turns a user-supplied path into a safe object key: forward slashes, no leading slash, no empty
 * segments, and never `..`, `.`, backslashes or control characters, so a key can't escape a local
 * disk's root or a scoped disk's prefix (FlyDrive's normaliser does the same job).
 */
export function normalizeKey(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new InvalidKeyError(String(input), 'it is empty')
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new InvalidKeyError(input, 'it contains control characters')
  if (input.includes('\\')) throw new InvalidKeyError(input, 'it contains a backslash')
  const segments = input.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) throw new InvalidKeyError(input, 'it has no name')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') throw new InvalidKeyError(input, 'it contains "." or ".." segments')
  }
  return segments.join('/')
}

/** A prefix for listing: like a key, but may be empty (the whole disk). Always ends in `/` when not empty. */
export function normalizePrefix(input: string | undefined): string {
  if (!input || input === '/' || input === '') return ''
  return `${normalizeKey(input)}/`
}

export class InvalidKeyError extends CalderaError {
  constructor(key: string, reason: string) {
    super('storage_key_invalid', `"${key}" isn't a usable file key: ${reason}.`, { key })
  }
}

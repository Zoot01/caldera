import { z } from 'zod'
import { imageSize } from './image-size.js'
import { sniff, type Sniffed } from './sniff.js'

export interface ZFileOptions {
  /** `'10mb'`, `'500kb'`, or bytes. */
  maxSize?: string | number
  minSize?: string | number
  /** Allowed kinds: mime types (`application/pdf`), families (`image/*`) or extensions (`pdf`). Checked against the bytes. */
  mimes?: readonly string[]
  /**
   * Dangerous kinds are refused even when `mimes` would match, unless listed here: `svg` and `html`
   * (they run script when served from your origin) and `executable`.
   */
  allow?: readonly ('svg' | 'html' | 'executable')[]
  /** Pixel limits, read from the image header. Implies an image (PNG, JPEG, GIF or WebP). */
  image?: { maxWidth?: number; maxHeight?: number; minWidth?: number; minHeight?: number }
}

/** What an accepted file really is, from its bytes. */
export interface DetectedFile {
  mime: string
  ext: string
  width?: number
  height?: number
}

export type ValidatedFile = File & { readonly detected: DetectedFile }

const EXECUTABLES = new Set(['exe', 'elf', 'macho', 'msi', 'dmg', 'apk', 'deb', 'rpm', 'dex', 'class', 'cab', 'swf', 'lnk'])

/** `'10mb'` → bytes. Binary units (1kb = 1024 bytes), like Laravel's `max` rule. */
export function parseSize(value: string | number): number {
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim())
  if (!match) throw new Error(`Can't read "${value}" as a size; use e.g. '500kb' or '10mb'.`)
  return Math.round(Number(match[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[match[2]!.toLowerCase() as 'b']!)
}

const human = (bytes: number) => (bytes >= 1024 ** 2 ? `${+(bytes / 1024 ** 2).toFixed(1)}MB` : bytes >= 1024 ? `${+(bytes / 1024).toFixed(1)}KB` : `${bytes} bytes`)

function matches(entry: string, found: Sniffed): boolean {
  const wanted = entry.toLowerCase()
  if (wanted.endsWith('/*')) return found.mime.startsWith(wanted.slice(0, -1))
  if (wanted.includes('/')) return found.mime === wanted
  return found.ext === wanted.replace(/^\./, '') || (wanted === 'jpeg' && found.ext === 'jpg') || (wanted === 'jpg' && found.ext === 'jpg')
}

/**
 * The checks zfile() runs, on the first bytes of a file and its total size, so they also apply to
 * a file already in a bucket (the upload flow reads its first 64KB with a range request).
 */
export async function inspectFile(head: Uint8Array, size: number, options: ZFileOptions = {}): Promise<{ ok: true; detected: DetectedFile } | { ok: false; message: string }> {
  const max = options.maxSize === undefined ? undefined : parseSize(options.maxSize)
  const min = options.minSize === undefined ? undefined : parseSize(options.minSize)
  const allow = new Set(options.allow ?? [])
  const refuse = (message: string) => ({ ok: false as const, message })
  if (max !== undefined && size > max) return refuse(`The file is ${human(size)}; the limit is ${human(max)}.`)
  if (min !== undefined && size < min) return refuse(`The file must be at least ${human(min)}.`)
  if (size === 0) return refuse('The file is empty.')
  const found = await sniff(head)
  const kind = !found ? undefined : found.ext === 'svg' ? 'svg' : found.mime === 'text/html' ? 'html' : EXECUTABLES.has(found.ext) ? 'executable' : undefined
  if (kind && !allow.has(kind)) return refuse(kind === 'executable' ? 'Programs can’t be uploaded.' : `${kind.toUpperCase()} files can’t be uploaded.`)
  if (options.mimes && (!found || !options.mimes.some((m) => matches(m, found)))) return refuse(`The file must be ${options.mimes.join(', ')}${found ? ` (it is ${found.ext})` : ''}.`)
  if (!found) return refuse('The file type couldn’t be recognised.')
  const detected: DetectedFile = { mime: found.mime, ext: found.ext }
  if (options.image) {
    const dimensions = imageSize(head, found.mime)
    if (!dimensions) return refuse('The file must be an image (PNG, JPEG, GIF or WebP).')
    const { maxWidth, maxHeight, minWidth, minHeight } = options.image
    if ((maxWidth && dimensions.width > maxWidth) || (maxHeight && dimensions.height > maxHeight)) {
      return refuse(`The image is ${dimensions.width}×${dimensions.height}; the limit is ${maxWidth ?? '∞'}×${maxHeight ?? '∞'}.`)
    }
    if ((minWidth && dimensions.width < minWidth) || (minHeight && dimensions.height < minHeight)) {
      return refuse(`The image is ${dimensions.width}×${dimensions.height}; it must be at least ${minWidth ?? 0}×${minHeight ?? 0}.`)
    }
    Object.assign(detected, dimensions)
  }
  return { ok: true, detected }
}

/** Bytes read from the start of a file for inspection: enough for every signature file-type knows. */
export const INSPECT_BYTES = 64 * 1024

/**
 * A Zod schema for an uploaded `File` that trusts the bytes, never the client: the type is sniffed
 * from magic numbers, sizes are measured, image dimensions are read from the header. SVG, HTML and
 * executables are refused unless `allow`ed. The parsed value is the same File, with `detected`.
 * Async: parse with `safeParseAsync` (`defineRequest` does).
 */
export function zfile(options: ZFileOptions = {}): z.ZodType<ValidatedFile, File> {
  // Fail on a bad size string when the schema is defined, not on the first upload.
  if (options.maxSize !== undefined) parseSize(options.maxSize)
  if (options.minSize !== undefined) parseSize(options.minSize)
  return z
    .instanceof(File, { message: 'Upload a file.' })
    .superRefine(async (file, ctx) => {
      const result = await inspectFile(new Uint8Array(await file.slice(0, INSPECT_BYTES).arrayBuffer()), file.size, options)
      if (!result.ok) return void ctx.addIssue({ code: 'custom', message: result.message })
      Object.defineProperty(file, 'detected', { value: result.detected, enumerable: false, configurable: true })
    }) as unknown as z.ZodType<ValidatedFile, File>
}

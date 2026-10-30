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
 * A Zod schema for an uploaded `File` that trusts the bytes, never the client: the type is sniffed
 * from magic numbers, sizes are measured, image dimensions are read from the header. SVG, HTML and
 * executables are refused unless `allow`ed. The parsed value is the same File, with `detected`.
 * Async: parse with `safeParseAsync` (`defineRequest` does).
 */
export function zfile(options: ZFileOptions = {}): z.ZodType<ValidatedFile, File> {
  const max = options.maxSize === undefined ? undefined : parseSize(options.maxSize)
  const min = options.minSize === undefined ? undefined : parseSize(options.minSize)
  const allow = new Set(options.allow ?? [])
  return z
    .instanceof(File, { message: 'Upload a file.' })
    .superRefine(async (file, ctx) => {
      if (max !== undefined && file.size > max) return void ctx.addIssue({ code: 'custom', message: `The file is ${human(file.size)}; the limit is ${human(max)}.` })
      if (min !== undefined && file.size < min) return void ctx.addIssue({ code: 'custom', message: `The file must be at least ${human(min)}.` })
      if (file.size === 0) return void ctx.addIssue({ code: 'custom', message: 'The file is empty.' })
      const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
      const found = await sniff(head)
      const kind = !found ? undefined : found.ext === 'svg' ? 'svg' : found.mime === 'text/html' ? 'html' : EXECUTABLES.has(found.ext) ? 'executable' : undefined
      if (kind && !allow.has(kind)) {
        return void ctx.addIssue({ code: 'custom', message: kind === 'executable' ? 'Programs can’t be uploaded.' : `${kind.toUpperCase()} files can’t be uploaded.` })
      }
      if (options.mimes && (!found || !options.mimes.some((m) => matches(m, found)))) {
        return void ctx.addIssue({ code: 'custom', message: `The file must be ${options.mimes.join(', ')}${found ? ` (it is ${found.ext})` : ''}.` })
      }
      if (!found && !options.mimes) return void ctx.addIssue({ code: 'custom', message: 'The file type couldn’t be recognised.' })
      const detected: DetectedFile = { mime: found!.mime, ext: found!.ext }
      if (options.image) {
        const size = imageSize(head, found!.mime)
        if (!size) return void ctx.addIssue({ code: 'custom', message: 'The file must be an image (PNG, JPEG, GIF or WebP).' })
        const { maxWidth, maxHeight, minWidth, minHeight } = options.image
        if ((maxWidth && size.width > maxWidth) || (maxHeight && size.height > maxHeight)) {
          return void ctx.addIssue({ code: 'custom', message: `The image is ${size.width}×${size.height}; the limit is ${maxWidth ?? '∞'}×${maxHeight ?? '∞'}.` })
        }
        if ((minWidth && size.width < minWidth) || (minHeight && size.height < minHeight)) {
          return void ctx.addIssue({ code: 'custom', message: `The image is ${size.width}×${size.height}; it must be at least ${minWidth ?? 0}×${minHeight ?? 0}.` })
        }
        Object.assign(detected, size)
      }
      Object.defineProperty(file, 'detected', { value: detected, enumerable: false, configurable: true })
    }) as unknown as z.ZodType<ValidatedFile, File>
}

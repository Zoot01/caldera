// file-type/core: the edge-safe entry (no Node APIs, no dynamic imports), so storage bundles for Workers.
import { fileTypeFromBuffer } from 'file-type/core'

export interface Sniffed {
  mime: string
  ext: string
}

/**
 * What a file's bytes say it is (magic numbers via file-type), never what the client claimed. Adds
 * the text formats magic numbers can't see: SVG, HTML and XML (dangerous when served from your
 * origin), then plain UTF-8 text. Undefined for unknown binary data.
 */
export async function sniff(head: Uint8Array): Promise<Sniffed | undefined> {
  const found = await fileTypeFromBuffer(head)
  // file-type reports an SVG with an `<?xml` prolog as plain XML: XML is text, so it gets the text
  // checks below too (an SVG passing as "xml" would run its scripts when served).
  if (found && found.mime !== 'application/xml' && found.mime !== 'text/xml') return { mime: found.mime, ext: found.ext }
  const text = utf8(head)
  if (text === undefined) return undefined
  const start = text.replace(/^﻿/, '').trimStart().slice(0, 1024).toLowerCase()
  if (/<svg[\s>]/.test(start) || (start.startsWith('<?xml') && start.includes('<svg'))) return { mime: 'image/svg+xml', ext: 'svg' }
  if (start.startsWith('<!doctype html') || /<(html|head|body|script|iframe)[\s>]/.test(start)) return { mime: 'text/html', ext: 'html' }
  if (start.startsWith('<?xml')) return { mime: 'application/xml', ext: 'xml' }
  if (start.startsWith('{') || start.startsWith('[')) {
    try {
      JSON.parse(text)
      return { mime: 'application/json', ext: 'json' }
    } catch {
      // Not (complete) JSON: plain text below.
    }
  }
  return { mime: 'text/plain', ext: 'txt' }
}

/** The bytes as text, if they're valid UTF-8 without binary control characters. */
function utf8(bytes: Uint8Array): string | undefined {
  // The sample may end mid-character: drop a trailing partial sequence before decoding strictly.
  let end = bytes.length
  for (let i = Math.max(0, bytes.length - 3); i < bytes.length; i++) if (bytes[i]! >= 0xc0) end = i
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : text
  } catch {
    return undefined
  }
}

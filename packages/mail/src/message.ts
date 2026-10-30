import { CalderaError } from '@caldera/core'

/** An address: `'ann@example.test'`, `'Ann <ann@example.test>'`, `{ name, email }`, or any row with `email` (a user). */
export type AddressInput = string | { email: string; name?: string | null }

export interface Address {
  email: string
  name?: string
}

export interface Attachment {
  filename: string
  content: Uint8Array
  contentType: string
  /** For inline images: `<img src="cid:logo">`. */
  contentId?: string
}

/** A fully rendered message, ready for a transport. */
export interface Message {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  subject: string
  html: string
  text: string | undefined
  headers: Record<string, string>
  attachments: Attachment[]
  /** Key/value tags (Resend tags, Postmark metadata, SES EmailTags). */
  tags: Record<string, string>
}

const ANGLE = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/
const BARE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export function parseAddress(input: AddressInput): Address {
  if (typeof input === 'object' && input !== null) {
    const email = String(input.email ?? '').trim()
    if (!BARE.test(email)) throw new CalderaError('mail_address_invalid', `"${email}" isn't an email address.`)
    return input.name ? { email, name: String(input.name) } : { email }
  }
  const angle = ANGLE.exec(input)
  if (angle) {
    if (!BARE.test(angle[2]!)) throw new CalderaError('mail_address_invalid', `"${input}" isn't an email address.`)
    return angle[1]?.trim() ? { name: angle[1].trim(), email: angle[2]! } : { email: angle[2]! }
  }
  const email = input.trim()
  if (!BARE.test(email)) throw new CalderaError('mail_address_invalid', `"${input}" isn't an email address.`)
  return { email }
}

/** RFC 5322 form: `"Ann Lee" <ann@example.test>`, quoting the name when it needs it. */
export function formatAddress(address: Address): string {
  if (!address.name) return address.email
  const name = /[^\w\s.'-]/.test(address.name) ? `"${address.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : address.name
  return `${name} <${address.email}>`
}

/** Bytes the message takes on the wire, roughly: attachments grow by a third in base64. */
export function messageSize(message: Message): number {
  const text = new TextEncoder()
  const base64 = (n: number) => Math.ceil(n / 3) * 4
  let size = 2048 // headers and MIME boundaries
  size += base64(text.encode(message.html).length)
  if (message.text) size += base64(text.encode(message.text).length)
  for (const attachment of message.attachments) size += base64(attachment.content.length) + 256
  return size
}

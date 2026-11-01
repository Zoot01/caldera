import { CalderaError } from '@caldera-js/core'
import { render } from '@react-email/render'
import { createElement, type ComponentType } from 'react'
import type { z } from 'zod'
import type { AddressInput, Attachment } from './message.js'

/** An attachment to resolve at send time: bytes now, or a file on a disk (`attach.fromStorage`). */
export type AttachmentSource = Attachment | { kind: 'storage'; disk?: string; key: string; filename?: string }

/** The app a mail is sent from (its config's `app.name` and `url`): `useApp()` in a mail component. */
export interface MailApp {
  name: string
  url: string
}

/** What a mail's `subject` and `text` functions get besides its props. */
export interface MailContext {
  app: MailApp
  /** The recipient's language, when the mail was sent with `.locale('fr')` (or by a notification to someone with one). */
  locale: string | undefined
}

export interface MailOptions<P extends z.ZodType> {
  /** Stable id, e.g. `users.welcome`: queued mail carries it, so renaming orphans queued jobs. */
  name: string
  props: P
  /** `(props, { app }) => …`: `app.name` is the app's name, so mails never copy it. */
  subject: string | ((props: z.output<P>, context: MailContext) => string)
  /** A React Email component. Its `PreviewProps` (or `preview`) are what the preview page renders. */
  component: ComponentType<z.output<P>>
  /** Plain text: `auto` derives it from the HTML (default); a function writes it; false sends none. */
  text?: 'auto' | false | ((props: z.output<P>, context: MailContext) => string)
  from?: AddressInput
  replyTo?: AddressInput
  attachments?: (props: z.output<P>) => AttachmentSource[] | Promise<AttachmentSource[]>
  tags?: (props: z.output<P>) => Record<string, string>
  /** Props for previews and tests. Defaults to the component's `PreviewProps`. */
  preview?: z.input<P>
}

export interface MailDefinition<P extends z.ZodType = z.ZodType> {
  readonly kind: 'caldera.mail'
  readonly name: string
  readonly props: P
  readonly options: MailOptions<P>
  readonly preview: z.input<P> | undefined
}
export type AnyMail = MailDefinition<any>
export type MailProps<M> = M extends MailDefinition<infer P> ? z.input<P> : never

export function defineMail<P extends z.ZodType>(options: MailOptions<P>): MailDefinition<P> {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(options.name)) throw new CalderaError('mail_name_invalid', `Mail name "${options.name}" should be a stable id like "users.welcome".`)
  const preview = options.preview ?? ((options.component as { PreviewProps?: z.input<P> }).PreviewProps)
  return { kind: 'caldera.mail', name: options.name, props: options.props, options, preview }
}

export interface Rendered {
  subject: string
  html: string
  text: string | undefined
}

// Not a React context: createContext doesn't exist in React's server-component build, which Next.js
// loads for anything app/ imports (src/app.ts imports this package).
let rendering: { app: MailApp; locale: string | undefined } | undefined
const DEFAULT_MAIL = Symbol.for('caldera.mail.default')

/** The app of the configured mail service, outside a render (e.g. a mail rendered by a test). */
function registeredApp(): MailApp {
  return (globalThis as { [DEFAULT_MAIL]?: { app?: MailApp } })[DEFAULT_MAIL]?.app ?? { name: '', url: '' }
}

/** Runs a render with `app` and `locale` as what useApp() and useLocale() give. */
async function within<T>(context: { app: MailApp; locale: string | undefined }, run: () => Promise<T>): Promise<T> {
  const previous = rendering
  rendering = context
  try {
    return await run()
  } finally {
    rendering = previous
  }
}

/** In a mail component: the app it's sent from, `{ name, url }` (from `config.app`). */
export function useApp(): MailApp {
  return rendering?.app ?? registeredApp()
}

/**
 * In a mail component: the recipient's language, when it was sent with `.locale('fr')` (or by a
 * notification to someone who has one), else undefined. With @caldera-js/i18n:
 * `const { t } = translator(useLocale())`.
 */
export function useLocale(): string | undefined {
  return rendering?.locale
}

/**
 * Renders a mail with its props (validated first). Uses React Email's render, whose package exports
 * pick the edge build on Workers. Never pretty-printed: that loads prettier.
 */
export async function renderMail<M extends AnyMail>(mail: M, input: MailProps<M>, context: { app?: MailApp; locale?: string } = {}): Promise<Rendered & { props: unknown }> {
  const parsed = mail.props.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || '(props)'}: ${i.message}`).join('; ')
    throw new CalderaError('mail_props_invalid', `Mail "${mail.name}" got props that don't match its schema: ${issues}.`, { issues: parsed.error.issues })
  }
  const props = parsed.data
  const app = context.app ?? registeredApp()
  const scope = { app, locale: context.locale }
  const element = createElement(mail.options.component, props)
  const html = await within(scope, () => render(element))
  const textOption = mail.options.text ?? 'auto'
  const text = textOption === false ? undefined : typeof textOption === 'function' ? textOption(props, scope) : await within(scope, () => render(element, { plainText: true }))
  const subject = typeof mail.options.subject === 'function' ? mail.options.subject(props, scope) : mail.options.subject
  return { subject, html, text, props }
}

/** Attachments for `defineMail({ attachments })`. Files on disks are read only when the mail is sent. */
export const attach = {
  content: (content: Uint8Array | string, filename: string, contentType = 'application/octet-stream'): Attachment => ({
    filename,
    content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
    contentType,
  }),
  fromStorage: (key: string, options: { disk?: string; filename?: string } = {}): AttachmentSource => ({ kind: 'storage', key, ...options }),
}

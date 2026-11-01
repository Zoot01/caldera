import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CalderaError } from '@caldera-js/core'
import { CONVENTIONS, exportsOfKind, mailFiles, type Project } from './project.js'

interface MailLike {
  name: string
  preview: unknown
  options: { subject: unknown }
}

/** Every mail exported from src/mail, with its export name and file. */
export async function loadMails(project: Project): Promise<{ file: string; exportName: string; mail: MailLike }[]> {
  const found = []
  for (const file of mailFiles(project)) {
    for (const { exportName, value } of exportsOfKind<MailLike>(await project.load(file), 'caldera.mail')) found.push({ file, exportName, mail: value })
  }
  return found
}

/** Every .tsx/.ts file under src/mail, shared components included. */
function mailSources(project: Project): string[] {
  const walk = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [])) : []
  return walk(project.path(CONVENTIONS.mailDir)).sort()
}

/**
 * The precompiled styles for mails using `Tailwind` from @caldera-js/mail/tailwind: React Email's own
 * Tailwind run once over every className in src/mail, per config the mails use (recorded by rendering
 * them with their preview props). Undefined when no mail uses it. `previous` is the last result (from
 * .caldera/mails.gen.ts): reused when the classes and configs haven't changed.
 */
export async function compileMailStyles(project: Project, previous?: { hash: string; json: string }): Promise<{ hash: string; json: string } | undefined> {
  const sources = mailSources(project).map((file) => readFileSync(file, 'utf8'))
  if (!sources.some((text) => text.includes('@caldera-js/mail/tailwind'))) return undefined
  const build = await project.importPackage<{ classNamesIn(source: string): string[]; compileTailwind(config: unknown, classNames: string[]): Promise<unknown> }>('@caldera-js/mail/tailwind-build')
  const runtime = await project.importPackage<{ recordTailwindConfigs(): { configs: unknown[]; stop(): void }; configKey(config: unknown): string }>('@caldera-js/mail/tailwind')
  const { renderMail } = await project.importPackage<{ renderMail(mail: unknown, props: unknown): Promise<unknown> }>('@caldera-js/mail')
  const classNames = [...new Set(sources.flatMap((text) => build.classNamesIn(text)))].sort()
  const recording = runtime.recordTailwindConfigs()
  const failures: string[] = []
  try {
    for (const { mail, file } of await loadMails(project)) {
      if (mail.preview === undefined) continue
      await renderMail(mail, mail.preview).catch((error: unknown) => failures.push(`${file}: ${(error as Error).message}`))
    }
  } finally {
    recording.stop()
  }
  const configs = new Map(recording.configs.map((config) => [runtime.configKey(config), config]))
  // Compiling for a guessed config would give silently wrong styles: say what went wrong instead.
  if (configs.size === 0 && failures.length) throw new CalderaError('mail_render_failed', `Couldn't render mails to find their Tailwind config:\n  ${failures.join('\n  ')}`)
  // A mail without preview props can't be rendered here: its config is assumed to be the default.
  if (configs.size === 0) configs.set(runtime.configKey({}), {})
  const hash = createHash('sha256').update(JSON.stringify([classNames, [...configs.keys()].sort()])).digest('hex').slice(0, 16)
  if (previous?.hash === hash) return previous
  const compiled: Record<string, unknown> = {}
  for (const [key, config] of configs) compiled[key] = await build.compileTailwind(config, classNames)
  return { hash, json: JSON.stringify(compiled) }
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { CalderaError } from '@caldera-js/core'
import { compareSignatures, flattenMessages, signatureOf, signatureType, type Signature } from '@caldera-js/i18n/icu'
import { pageFiles } from './pages.js'
import { CONVENTIONS, type Project } from './project.js'

export interface LoadedLang {
  /** The locale whose messages are the source of truth and the types. */
  canonical: string
  /** locale → key → message: the app's own, over the built-in validation and error messages. */
  messages: Record<string, Record<string, string>>
  /** locale → key → file it came from (`built-in` for @caldera-js/i18n's). */
  sources: Record<string, Record<string, string>>
  /** Page component → the message patterns it declared with `export const messages = [...]`. */
  pages: Record<string, string[]>
}

/** Messages @caldera-js/i18n ships, for the frameworks' own keys (`validation.*`, `errors.*`). */
function builtinLangDir(project: Project): string | undefined {
  try {
    const manifest = createRequire(project.path('package.json')).resolve('@caldera-js/i18n/package.json')
    const dir = join(dirname(manifest), 'lang')
    return existsSync(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

const readLocaleDir = (dir: string, label: (file: string) => string, into: Record<string, string>, sources: Record<string, string>) => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (error) {
      throw new CalderaError('lang_file_invalid', `${label(file)} isn't valid JSON: ${(error as Error).message}`, { file: label(file) })
    }
    let flat: Record<string, string>
    try {
      flat = flattenMessages(file.replace(/\.json$/, ''), parsed)
    } catch (error) {
      throw new CalderaError('lang_file_invalid', `${label(file)}: ${(error as Error).message}`, { file: label(file) })
    }
    for (const [key, message] of Object.entries(flat)) {
      into[key] = message
      sources[key] = label(file)
    }
  }
}

/** The app's default locale, read from src/config/i18n.ts when it's a literal; otherwise `en`, or the only locale. */
function canonicalLocale(project: Project, locales: string[]): string {
  const configFile = project.path(`${CONVENTIONS.configDir}/i18n.ts`)
  if (existsSync(configFile)) {
    const literal = /defaultLocale:\s*['"]([^'"]+)['"]/.exec(readFileSync(configFile, 'utf8'))?.[1]
    if (literal) return literal
  }
  if (locales.length === 1) return locales[0]!
  return locales.includes('en') ? 'en' : (locales[0] ?? 'en')
}

/** `export const messages = ['posts.*', 'common.save']` in a page, read without importing it. */
function pageMessages(project: Project): Record<string, string[]> {
  const pages: Record<string, string[]> = {}
  for (const page of pageFiles(project)) {
    const source = readFileSync(project.path(page.file), 'utf8')
    const match = /export\s+const\s+messages\s*=\s*\[([\s\S]*?)\]/.exec(source)
    if (!match) continue
    const body = match[1]!.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    const items = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!)
    if (body.replace(/'[^']*'|"[^"]*"/g, '').replace(/[\s,]/g, '') !== '') {
      throw new CalderaError('page_messages_invalid', `${page.file}: \`export const messages\` must be a literal array of strings (\`caldera generate\` reads it without running the page).`, { file: page.file })
    }
    pages[page.name] = items
  }
  return pages
}

/** Reads lang/<locale>/*.json (and the built-in messages), checking every message parses. */
export function loadLang(project: Project): LoadedLang | undefined {
  const root = project.path(CONVENTIONS.langDir)
  const appLocales = existsSync(root) ? readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort() : []
  const builtin = builtinLangDir(project)
  if (!appLocales.length && !builtin) return undefined
  const canonical = canonicalLocale(project, appLocales)
  const locales = [...new Set([canonical, ...appLocales])]
  const messages: LoadedLang['messages'] = {}
  const sources: LoadedLang['sources'] = {}
  for (const locale of locales) {
    const into: Record<string, string> = (messages[locale] = {})
    const from: Record<string, string> = (sources[locale] = {})
    // Built-in first, so the app's own files override any key.
    const builtinFor = builtin && [locale, locale.split('-')[0]!].find((l) => existsSync(join(builtin, l)))
    if (builtinFor) readLocaleDir(join(builtin, builtinFor), () => 'built-in', into, from)
    if (existsSync(join(root, locale))) readLocaleDir(join(root, locale), (file) => `${CONVENTIONS.langDir}/${locale}/${file}`, into, from)
  }
  const broken: string[] = []
  for (const [locale, entries] of Object.entries(messages)) {
    for (const [key, message] of Object.entries(entries)) {
      try {
        signatureOf(message)
      } catch (error) {
        broken.push(`${sources[locale]![key]} "${key}": ${(error as Error).message}`)
      }
    }
  }
  if (broken.length) throw new CalderaError('message_invalid', `Messages that aren't valid ICU:\n  ${broken.join('\n  ')}`, { messages: broken })
  return { canonical, messages, sources, pages: pageMessages(project) }
}

/** `.caldera/i18n.gen.ts`: every locale's messages and each page's declared patterns. */
export function i18nGen(lang: LoadedLang, header: string): string {
  return (
    header +
    `import type { Catalog } from '@caldera-js/i18n'\n\n` +
    `/** Canonical locale: ${lang.canonical}. */\n` +
    `export const messages: Catalog = ${JSON.stringify(lang.messages, null, 2)}\n\n` +
    `export const pages: Record<string, readonly string[]> = ${JSON.stringify(lang.pages, null, 2)}\n`
  )
}

/** The `@caldera-js/i18n` block of register.d.ts: each canonical key and its parameters. */
export function i18nRegister(lang: LoadedLang): string {
  const entries = Object.entries(lang.messages[lang.canonical] ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return (
    `\ndeclare module '@caldera-js/i18n' {\n` +
    `  interface I18nRegister {\n` +
    `    messages: {\n` +
    entries.map(([key, message]) => `      ${JSON.stringify(key)}: ${signatureType(signatureOf(message))}\n`).join('') +
    `    }\n` +
    `  }\n` +
    `}\n`
  )
}

export interface I18nReport {
  schemaVersion: 1
  canonical: string
  /** Messages in the canonical locale. */
  total: number
  locales: { locale: string; total: number; missing: string[]; extra: string[]; mismatched: { key: string; file: string; problems: string[] }[] }[]
  /** Canonical keys no source file mentions (validation.* and errors.* are the framework's). */
  unused: string[]
  /** Page patterns that match no message. */
  unknownPagePatterns: { page: string; pattern: string }[]
}

/** `caldera i18n:missing`: what each locale lacks, has extra, or takes differently from the canonical. */
export function i18nReport(project: Project): I18nReport {
  const lang = loadLang(project)
  if (!lang) throw new CalderaError('i18n_not_used', `No ${CONVENTIONS.langDir}/ folder and no @caldera-js/i18n in this app.`)
  const canonical = lang.messages[lang.canonical] ?? {}
  const signatures = new Map<string, Signature>(Object.entries(canonical).map(([key, message]) => [key, signatureOf(message)]))
  const locales = Object.entries(lang.messages)
    .filter(([locale]) => locale !== lang.canonical)
    .map(([locale, entries]) => ({
      locale,
      total: Object.keys(entries).length,
      missing: Object.keys(canonical).filter((key) => !(key in entries)),
      extra: Object.keys(entries).filter((key) => !(key in canonical)),
      mismatched: Object.entries(entries)
        .filter(([key]) => signatures.has(key))
        .map(([key, message]) => ({ key, file: lang.sources[locale]![key]!, problems: compareSignatures(signatures.get(key)!, signatureOf(message)) }))
        .filter((m) => m.problems.length > 0),
    }))
  const code = ['src', 'resources'].flatMap((dir) => codeFiles(project.path(dir))).map((file) => readFileSync(file, 'utf8')).join('\n')
  const unused = Object.keys(canonical).filter((key) => !/^(validation|errors)\./.test(key) && !code.includes(`'${key}'`) && !code.includes(`"${key}"`) && !code.includes(`\`${key}\``))
  const keys = Object.keys(canonical)
  const unknownPagePatterns = Object.entries(lang.pages).flatMap(([page, patterns]) =>
    patterns.filter((pattern) => !(pattern === '*' || keys.some((key) => (pattern.endsWith('.*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern)))).map((pattern) => ({ page, pattern })),
  )
  return { schemaVersion: 1, canonical: lang.canonical, total: Object.keys(canonical).length, locales, unused, unknownPagePatterns }
}

/** Every .ts/.tsx/.js/.jsx file under `dir`, recursively (skipping node_modules and generated code). */
function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...codeFiles(path))
    else if (/\.[jt]sx?$/.test(entry.name)) out.push(path)
  }
  return out
}

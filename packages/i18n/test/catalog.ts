import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flattenMessages } from '../src/icu.js'

/** The built-in validation/errors messages plus the app's, as `caldera generate` merges them. */
export function catalog(app: Record<string, Record<string, unknown>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  const builtin = join(import.meta.dirname, '../lang')
  for (const locale of readdirSync(builtin)) {
    for (const file of readdirSync(join(builtin, locale))) {
      Object.assign((out[locale] ??= {}), flattenMessages(file.replace(/\.json$/, ''), JSON.parse(readFileSync(join(builtin, locale, file), 'utf8'))))
    }
  }
  for (const [locale, namespaces] of Object.entries(app)) {
    for (const [namespace, messages] of Object.entries(namespaces)) Object.assign((out[locale] ??= {}), flattenMessages(namespace, messages))
  }
  return out
}

export const messages = catalog({
  en: {
    posts: {
      count: '{count, plural, =0 {No posts} one {# post} other {# posts}}',
      greeting: 'Hello, {name}!',
      published: 'Published {when, date, medium}',
      by: '{gender, select, female {by her} male {by him} other {by them}}',
      link: 'Read <b>the guide</b>',
    },
    common: { save: 'Save', cancel: 'Cancel' },
    only: { english: 'Only in English' },
    validation: { attributes: { email: 'email address' }, custom: { 'password.too_small.string': 'Pick a longer password (at least {minimum} characters).' } },
  },
  fr: {
    posts: {
      count: '{count, plural, =0 {Aucun article} one {# article} other {# articles}}',
      greeting: 'Bonjour, {name} !',
      published: 'Publié le {when, date, medium}',
      by: '{gender, select, female {par elle} male {par lui} other {par eux}}',
      link: 'Lire <b>le guide</b>',
    },
    common: { save: 'Enregistrer' },
    validation: { attributes: { email: 'adresse e-mail' } },
  },
  'fr-CA': { common: { save: 'Sauvegarder' } },
})

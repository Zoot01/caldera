import { defineConfig } from '@caldera-js/core'

export const i18n = defineConfig('i18n', (env) => ({
  // The canonical locale: lang/en/*.json are the source of truth, and of the types for t().
  defaultLocale: 'en',
  // Add a locale: create lang/<locale>/ with the same files, and list it here.
  locales: ['en'],
  // Development shows untranslated text as ⟦…⟧; production falls back to the default locale.
  missing: env.NODE_ENV === 'production' ? ('fallback' as const) : ('marker' as const),
}))

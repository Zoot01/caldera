import { defineConfig } from '@caldera/core'

export const i18n = defineConfig('i18n', () => ({ defaultLocale: 'en', locales: ['en', 'fr'] }))

import { usePage } from '@inertiajs/react'
import { useMemo } from 'react'
import { createClientTranslator, type ClientTranslator, type PageI18n } from './translator.js'

export { createClientTranslator, type ClientTranslator, type PageI18n, type RichParams } from './translator.js'

/** `const { t } = useT()` in a page or component: typed keys, the page's locale. Reads the `i18n` shared prop. */
export function useT(): ClientTranslator {
  const { i18n } = usePage<{ i18n?: PageI18n }>().props
  if (!i18n) throw new Error('useT() needs the `i18n` shared prop: add `i18n: c.var.i18n.page(component)` to `share` in src/inertia.ts.')
  return useMemo(() => createClientTranslator(i18n), [i18n])
}

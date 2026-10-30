import { i18nOf } from '@caldera/i18n'
import { defineInertia, viteAssets } from '@caldera/inertia'

/** Pages: shared props, asset tags and the HTML shell. `caldera generate` types `share` for every page. */
export const inertia = defineInertia({
  assets: viteAssets({ entry: 'resources/app.tsx' }),
  title: '{{ name }}',
  share: (c, { component }) => ({
    appName: '{{ name }}',
    // The locale and the messages this page declared (`export const messages`), for useT().
    i18n: i18nOf(c).page(component),
  }),
})

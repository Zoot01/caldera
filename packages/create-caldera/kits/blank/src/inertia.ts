import { i18nOf } from '@caldera/i18n'
import { appearance, appearanceOf, defineInertia, viteAssets, viteSsr } from '@caldera/inertia'

/** Pages: shared props, asset tags and the HTML shell. `caldera generate` types `share` for every page. */
export const inertia = defineInertia({
  assets: viteAssets({ entry: 'resources/app.tsx' }),
  // First loads are rendered on the server (resources/ssr.tsx), then hydrated; client-side if it fails.
  ssr: viteSsr(),
  title: '{{ name }}',
  // Light, dark or system from the `appearance` cookie, painted right on the first load.
  document: [appearance()],
  share: (c, { component }) => ({
    appName: '{{ name }}',
    // For useAppearance() while hydrating (resources/hooks/use-appearance.ts).
    appearance: appearanceOf(c),
    // The locale and the messages this page declared (`export const messages`), for useT().
    i18n: i18nOf(c).page(component),
    // How the browser reaches the realtime server (no secrets); null when there's none (log, null).
    broadcast: c.var.broadcast.client() ?? null,
  }),
})

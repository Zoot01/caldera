import { i18nOf } from '@caldera/i18n'
import { appearance, appearanceOf, defineInertia, viteAssets, viteSsr } from '@caldera/inertia'
import { getCookie } from 'hono/cookie'

/** Pages: shared props, asset tags and the HTML shell. `caldera generate` types `share` for every page. */
export const inertia = defineInertia({
  assets: viteAssets({ entry: 'resources/app.tsx' }),
  // First loads are rendered on the server (resources/ssr.tsx), then hydrated; client-side if it fails.
  ssr: viteSsr(),
  // The app's name, from src/config/app.ts (APP_NAME).
  title: (c) => c.var.config.app.name,
  // Light, dark or system from the `appearance` cookie, painted right on the first load; and the
  // tab icon, public/favicon.svg (replace it with your own).
  document: [appearance(), { head: () => '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' }],
  share: (c, { component }) => ({
    appName: c.var.config.app.name,
    // For useAppearance() while hydrating (resources/hooks/use-appearance.ts).
    appearance: appearanceOf(c),
    // Whether the sidebar is open (the sidebar_state cookie), so the server renders it as it was left.
    sidebarOpen: getCookie(c, 'sidebar_state') !== 'false',
    // The signed-in user (or null), for the layouts and pages.
    auth: { user: c.var.user ? { id: c.var.user.id, name: c.var.user.name, email: c.var.user.email, emailVerified: c.var.user.emailVerified, image: c.var.user.image ?? null } : null },
    // The locale and the messages this page declared (`export const messages`), for useT().
    i18n: i18nOf(c).page(component),
    // How the browser reaches the realtime server (no secrets); null when there's none (log, null).
    broadcast: c.var.broadcast.client() ?? null,
  }),
})

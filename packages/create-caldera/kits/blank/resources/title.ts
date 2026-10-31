import type { Page } from '@inertiajs/core'

/** The document title for a page: its own, then the app's name (the shared `appName` prop, from config.app.name). */
export const title = (title: string, page: Page) => {
  const app = String(page.props.appName ?? '')
  return title && app ? `${title} · ${app}` : title || app
}

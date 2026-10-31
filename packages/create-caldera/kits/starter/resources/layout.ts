import AppLayout from '@/layouts/app-layout'
import AuthLayout from '@/layouts/auth-layout'
import SettingsLayout from '@/layouts/settings-layout'

/**
 * The layout a page is wrapped in, by page name (used by app.tsx and ssr.tsx). Pages pass it props
 * with `Page.layout = { breadcrumbs: [...] }`, or pick another with `Page.layout = MyLayout`.
 */
export function layout(name: string) {
  if (name === 'Home' || name === 'Error') return null
  if (name.startsWith('auth/')) return AuthLayout
  if (name.startsWith('settings/')) return [AppLayout, SettingsLayout]
  return AppLayout
}

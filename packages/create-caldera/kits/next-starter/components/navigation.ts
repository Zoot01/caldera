import { BookOpen, LayoutGrid } from 'lucide-react'
import type { BreadcrumbItem, NavItem } from '@/types'

/** The app's main navigation, in the sidebar and the header. Add your pages here. */
export const mainNavItems: NavItem[] = [{ title: 'Dashboard', href: '/dashboard', icon: LayoutGrid }]

/** The settings pages: the side navigation of Settings, and the command menu (⌘K). */
export const settingsNavItems: NavItem[] = [
  { title: 'Profile', href: '/settings/profile' },
  { title: 'Security', href: '/settings/security' },
  { title: 'Appearance', href: '/settings/appearance' },
]

/** Links at the bottom of the sidebar (and the right of the header). */
export const footerNavItems: NavItem[] = [{ title: 'Documentation', href: 'https://calderajs.dev/docs', icon: BookOpen }]

/** Is `href` the current page (or a page under it)? */
export const isCurrent = (url: string, href: string) => {
  const path = url.split(/[?#]/)[0]!
  return path === href || path.startsWith(`${href}/`)
}

/** The trail to `path` for the sidebar layout's header: its page, or Settings and the settings page. */
export function breadcrumbsFor(path: string): BreadcrumbItem[] {
  const setting = settingsNavItems.find((item) => isCurrent(path, item.href))
  if (setting) return [{ title: 'Settings', href: '/settings/profile' }, { title: setting.title, href: setting.href }]
  const page = mainNavItems.find((item) => isCurrent(path, item.href))
  return page ? [{ title: page.title, href: page.href }] : []
}

import type { LucideIcon } from 'lucide-react'

export interface BreadcrumbItem {
  title: string
  href: string
}

export interface NavItem {
  title: string
  href: string
  icon?: LucideIcon
}

/** What a page passes its layout: `Dashboard.layout = { breadcrumbs: [...] }`, or a title for auth pages. */
export interface LayoutProps {
  breadcrumbs?: BreadcrumbItem[]
  title?: string
  description?: string
}

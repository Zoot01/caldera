import type { Flash } from '@/components/flash-toasts'
import type { UserSummary } from '@/components/user-info'
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

/** What an auth page passes its layout: `<AuthLayout title="Log in" description="…">`. */
export interface LayoutProps {
  title?: string
  description?: string
}

/** What app/(app)/layout.tsx gives the app layout: the signed-in user, what was flashed, the sidebar's state. */
export interface AppLayoutProps {
  user: UserSummary | null
  flash: Flash
  /** Open or folded as the visitor left it (the sidebar_state cookie), so the server renders it that way. */
  sidebarOpen: boolean
}

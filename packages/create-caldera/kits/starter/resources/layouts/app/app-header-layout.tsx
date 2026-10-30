import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import type { LayoutProps } from '@/types'

/** The other app layout: navigation across the top. Use it from layouts/app-layout.tsx. */
export default function AppHeaderLayout({ breadcrumbs = [], children }: LayoutProps & { children: ReactNode }) {
  return (
    <div className="flex min-h-svh w-full flex-col">
      <AppHeader breadcrumbs={breadcrumbs} />
      <main className="mx-auto flex w-full flex-1 flex-col gap-4 p-4 md:max-w-7xl">{children}</main>
    </div>
  )
}

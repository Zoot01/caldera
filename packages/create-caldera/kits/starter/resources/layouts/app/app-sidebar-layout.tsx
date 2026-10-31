import { usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { Breadcrumbs } from '@/components/breadcrumbs'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import type { LayoutProps } from '@/types'

/** The other app layout: a collapsible sidebar, and breadcrumbs above the page. Use it from layouts/app-layout.tsx. */
export default function AppSidebarLayout({ breadcrumbs = [], children }: LayoutProps & { children: ReactNode }) {
  // Open or folded as the visitor left it (the sidebar_state cookie), so the server renders it that way.
  const { sidebarOpen } = usePage().props
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar />
      <SidebarInset className="overflow-x-hidden bg-surface md:peer-data-[variant=inset]:border">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 md:rounded-t-xl transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <SidebarTrigger className="-ms-1" />
          <Breadcrumbs breadcrumbs={breadcrumbs} />
        </header>
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 md:px-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}

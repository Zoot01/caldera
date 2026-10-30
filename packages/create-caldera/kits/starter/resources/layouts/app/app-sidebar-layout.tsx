import { usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { Breadcrumbs } from '@/components/breadcrumbs'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import type { LayoutProps } from '@/types'

/** The default app layout: a collapsible sidebar, and breadcrumbs above the page. */
export default function AppSidebarLayout({ breadcrumbs = [], children }: LayoutProps & { children: ReactNode }) {
  // Open or folded as the visitor left it (the sidebar_state cookie), so the server renders it that way.
  const { sidebarOpen } = usePage().props
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar />
      <SidebarInset className="overflow-x-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <SidebarTrigger className="-ms-1" />
          <Breadcrumbs breadcrumbs={breadcrumbs} />
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}

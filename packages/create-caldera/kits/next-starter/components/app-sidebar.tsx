'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronsUpDown } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { footerNavItems, isCurrent, mainNavItems } from '@/components/navigation'
import { Menu, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { UserInfo, type UserSummary } from '@/components/user-info'
import { UserMenuContent } from '@/components/user-menu-content'

/**
 * The sidebar of the default app layout. `variant` is "sidebar", "inset" or "floating";
 * `collapsible="icon"` folds it to icons (Ctrl/Cmd+B toggles it).
 */
export function AppSidebar({ user }: { user: UserSummary | null }) {
  const url = usePathname()
  const { isMobile, state } = useSidebar()
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              <AppLogo />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarMenu>
            {mainNavItems.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton isActive={isCurrent(url, item.href)} tooltip={item.title} render={<Link href={item.href} />}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              {footerNavItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton tooltip={item.title} className="text-muted-foreground" render={<a href={item.href} target="_blank" rel="noopener" />}>
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {user && (
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <Menu>
                <MenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
                  <UserInfo user={user} />
                  <ChevronsUpDown className="ms-auto size-4" />
                </MenuTrigger>
                <MenuPopup className="w-56" align="end" side={isMobile ? 'top' : state === 'collapsed' ? 'right' : 'top'}>
                  <UserMenuContent user={user} />
                </MenuPopup>
              </Menu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  )
}

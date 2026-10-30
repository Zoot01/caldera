import { Link, usePage } from '@inertiajs/react'
import { Menu as MenuIcon } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { Breadcrumbs } from '@/components/breadcrumbs'
import { footerNavItems, isCurrent, mainNavItems } from '@/components/navigation'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { UserInfo } from '@/components/user-info'
import { UserMenuContent } from '@/components/user-menu-content'
import { cn } from '@/lib/utils'
import type { BreadcrumbItem } from '@/types'

/** The header of the header layout: logo, navigation, and the user menu. */
export function AppHeader({ breadcrumbs = [] }: { breadcrumbs?: BreadcrumbItem[] }) {
  const { url, props } = usePage()
  const user = props.auth.user
  return (
    <>
      <div className="border-b">
        <div className="mx-auto flex h-14 items-center gap-2 px-4 md:max-w-7xl">
          {/* Small screens: the navigation in a menu. */}
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon" className="lg:hidden" aria-label="Navigation" />}>
              <MenuIcon />
            </MenuTrigger>
            <MenuPopup align="start" className="w-48">
              {mainNavItems.map((item) => (
                <MenuItem key={item.href} render={<Link href={item.href} />}>
                  {item.icon && <item.icon />}
                  {item.title}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          <Link href="/dashboard" prefetch className="flex items-center gap-2">
            <AppLogo />
          </Link>
          <nav className="ms-6 hidden h-full items-center gap-1 lg:flex">
            {mainNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={cn('flex h-8 items-center gap-2 rounded-md px-3 text-sm hover:bg-accent', isCurrent(url, item.href) && 'bg-accent font-medium')}
              >
                {item.icon && <item.icon className="size-4" />}
                {item.title}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-2">
            {footerNavItems.map((item) => (
              <Button key={item.href} variant="ghost" size="icon" render={<a href={item.href} target="_blank" rel="noopener" aria-label={item.title} title={item.title} />}>
                {item.icon && <item.icon />}
              </Button>
            ))}
            {user && (
              <Menu>
                <MenuTrigger render={<Button variant="ghost" className="h-9 gap-2 px-1.5" aria-label="Account" />}>
                  <UserInfo user={user} />
                </MenuTrigger>
                <MenuPopup align="end" className="w-56">
                  <UserMenuContent user={user} />
                </MenuPopup>
              </Menu>
            )}
          </div>
        </div>
      </div>
      {breadcrumbs.length > 1 && (
        <div className="border-b">
          <div className="mx-auto flex h-12 items-center px-4 md:max-w-7xl">
            <Breadcrumbs breadcrumbs={breadcrumbs} />
          </div>
        </div>
      )}
    </>
  )
}

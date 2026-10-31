import { Link, usePage } from '@inertiajs/react'
import { AppLogo } from '@/components/app-logo'
import { CommandMenu } from '@/components/command-menu'
import { footerNavItems, isCurrent, mainNavItems } from '@/components/navigation'
import { Button } from '@/components/ui/button'
import { Menu, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { UserInfo } from '@/components/user-info'
import { UserMenuContent } from '@/components/user-menu-content'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/types'

// The tabs: your pages (resources/components/navigation.ts), then settings.
const tabs: NavItem[] = [...mainNavItems, { title: 'Settings', href: '/settings' }]

/** The top of the header layout: the logo and the user menu, with the pages as tabs below. */
export function AppHeader() {
  const { url, props } = usePage()
  const user = props.auth.user
  return (
    <header className="bg-background">
      <div className="flex h-14 items-center gap-2 px-4 md:px-6">
        <Link href="/dashboard" prefetch className="flex items-center gap-2">
          <AppLogo />
        </Link>
        <div className="ms-auto flex items-center gap-1">
          <CommandMenu className="me-1" />
          {footerNavItems.map((item) => (
            <Button key={item.href} variant="ghost" size="icon" render={<a href={item.href} target="_blank" rel="noopener" aria-label={item.title} title={item.title} />}>
              {item.icon && <item.icon />}
            </Button>
          ))}
          {user && (
            <Menu>
              <MenuTrigger render={<Button variant="ghost" className="h-9 gap-2 px-1.5" aria-label={`Account: ${user.name}`} />}>
                <UserInfo user={user} />
              </MenuTrigger>
              <MenuPopup align="end" className="w-56">
                <UserMenuContent user={user} />
              </MenuPopup>
            </Menu>
          )}
        </div>
      </div>
      {/* Over the panel's top border, so the current tab's line sits on it. */}
      <nav className="relative z-10 -mb-px flex gap-6 overflow-x-auto px-4 md:px-6" aria-label="Main">
        {tabs.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            aria-current={isCurrent(url, item.href) ? 'page' : undefined}
            className={cn(
              'shrink-0 border-transparent border-b-2 pt-1 pb-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground',
              isCurrent(url, item.href) && 'border-foreground font-medium text-foreground',
            )}
          >
            {item.title}
          </Link>
        ))}
      </nav>
    </header>
  )
}

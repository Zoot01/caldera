import { Link, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { Heading } from '@/components/heading'
import { isCurrent } from '@/components/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/types'

const items: NavItem[] = [
  { title: 'Profile', href: '/settings/profile' },
  { title: 'Security', href: '/settings/security' },
  { title: 'Appearance', href: '/settings/appearance' },
]

/** Inside the app layout for settings pages: the sections on the side, the page beside them. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { url } = usePage()
  return (
    <div>
      <Heading title="Settings" description="Manage your profile and account settings" />
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
        <aside className="w-full lg:w-48">
          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Settings">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={cn('shrink-0 rounded-md px-3 py-1.5 text-muted-foreground text-sm hover:text-foreground', isCurrent(url, item.href) && 'bg-muted font-medium text-foreground')}
              >
                {item.title}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1 lg:max-w-2xl">
          <section className="space-y-6">{children}</section>
        </div>
      </div>
    </div>
  )
}

import { Link, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { Heading } from '@/components/heading'
import { isCurrent } from '@/components/navigation'
import { Separator } from '@/components/ui/separator'
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
    <div className="px-2 py-4 md:px-4">
      <Heading title="Settings" description="Manage your profile and account settings" />
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        <aside className="w-full max-w-xl lg:w-48">
          <nav className="flex flex-col gap-1" aria-label="Settings">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={cn('rounded-md px-3 py-1.5 text-sm hover:bg-accent', isCurrent(url, item.href) && 'bg-accent font-medium')}
              >
                {item.title}
              </Link>
            ))}
          </nav>
        </aside>
        <Separator className="lg:hidden" />
        <div className="flex-1 md:max-w-2xl">
          <section className="max-w-xl space-y-12">{children}</section>
        </div>
      </div>
    </div>
  )
}

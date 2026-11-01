'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { Heading } from '@/components/heading'
import { isCurrent, settingsNavItems } from '@/components/navigation'
import { cn } from '@/lib/utils'

/** Inside the app layout for settings pages: the sections on the side, the page beside them. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const url = usePathname()
  return (
    <div>
      <Heading title="Settings" description="Manage your profile and account settings" />
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
        <aside className="w-full lg:w-48">
          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Settings">
            {settingsNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
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

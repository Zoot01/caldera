import type { ReactNode } from 'react'
import { AppFooter } from '@/components/app-footer'
import { AppHeader } from '@/components/app-header'
import { FlashToasts } from '@/components/flash-toasts'
import type { AppLayoutProps } from '@/types'

/**
 * The default app layout: the header and its tabs on white, and the page in a panel below. Pages put
 * white cards on the panel (`bg-card`, or Section from components/section.tsx).
 */
export default function AppHeaderLayout({ user, flash, children }: AppLayoutProps & { children: ReactNode }) {
  return (
    <FlashToasts flash={flash}>
      <div className="flex min-h-svh w-full flex-col bg-background">
        <AppHeader user={user} />
        <main className="mx-1 mb-1 flex flex-1 flex-col rounded-lg border bg-surface md:mx-2 md:mb-2">
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 md:px-8">{children}</div>
          <AppFooter />
        </main>
      </div>
    </FlashToasts>
  )
}

import Link from 'next/link'
import type { ReactNode } from 'react'
import { CalderaLogo } from '@/components/caldera-logo'
import { ART_BACKGROUND, WelcomeArt } from '@/components/welcome-art'
import type { LayoutProps } from '@/types'

/**
 * The default auth layout: the logo and the form on the left, and on wide screens the welcome page's
 * poster on the right (swap in your own logo and art, or a screenshot of your app).
 */
export default function AuthSplitLayout({ title, description, children }: LayoutProps & { children: ReactNode }) {
  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex flex-col p-6 md:p-10">
        <Link href="/" className="w-fit">
          <CalderaLogo className="h-7 w-auto" />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="flex w-full max-w-sm flex-col gap-6">
            <div className="space-y-1.5">
              <h1 className="font-medium text-2xl tracking-tight">{title}</h1>
              {description && <p className="text-balance text-muted-foreground text-sm">{description}</p>}
            </div>
            {children}
          </div>
        </div>
      </div>
      <div className={`relative hidden overflow-hidden lg:block ${ART_BACKGROUND}`}>
        <WelcomeArt className="absolute right-0 bottom-0 aspect-[12/11] w-[60%] max-w-[520px]" />
      </div>
    </div>
  )
}

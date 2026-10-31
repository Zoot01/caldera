import { Link } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppLogoIcon } from '@/components/app-logo-icon'
import type { LayoutProps } from '@/types'

/** The default auth layout: the form centred on the page. */
export default function AuthSimpleLayout({ title, description, children }: LayoutProps & { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col items-center gap-4">
            <Link href="/" className="flex flex-col items-center gap-2 font-medium">
              <AppLogoIcon className="size-9" />
              <span className="sr-only">{title}</span>
            </Link>
            <div className="space-y-2 text-center">
              <h1 className="font-semibold text-xl">{title}</h1>
              {description && <p className="text-balance text-center text-muted-foreground text-sm">{description}</p>}
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

import { Link, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppLogoIcon } from '@/components/app-logo-icon'
import type { LayoutProps } from '@/types'

/** An auth layout with a panel for your brand beside the form (on wide screens). Use it from layouts/auth-layout.tsx. */
export default function AuthSplitLayout({ title, description, children }: LayoutProps & { children: ReactNode }) {
  const { appName } = usePage().props
  return (
    <div className="relative grid min-h-svh flex-col items-center justify-center px-8 sm:px-0 lg:max-w-none lg:grid-cols-2 lg:px-0">
      <div className="relative hidden h-full flex-col bg-primary p-10 text-primary-foreground lg:flex">
        <Link href="/" className="relative z-20 flex items-center gap-2 font-medium text-lg">
          <AppLogoIcon className="size-8" />
          {appName}
        </Link>
        <blockquote className="relative z-20 mt-auto space-y-2">
          <p className="text-lg">Say what your app does for people, in one line.</p>
        </blockquote>
      </div>
      <div className="w-full lg:p-8">
        <div className="mx-auto flex w-full flex-col justify-center gap-6 sm:w-[350px]">
          <Link href="/" className="relative z-20 flex items-center justify-center lg:hidden">
            <AppLogoIcon className="size-10" />
          </Link>
          <div className="flex flex-col items-start gap-2 text-start sm:items-center sm:text-center">
            <h1 className="font-semibold text-xl">{title}</h1>
            {description && <p className="text-balance text-muted-foreground text-sm">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

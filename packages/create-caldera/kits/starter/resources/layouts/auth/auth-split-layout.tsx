import { Link, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppLogoIcon } from '@/components/app-logo-icon'
import type { LayoutProps } from '@/types'

/**
 * The default auth layout: the form on the left, and on wide screens a dark panel on the right that
 * previews the app (replace the sketch in AppPreview with a screenshot of yours).
 */
export default function AuthSplitLayout({ title, description, children }: LayoutProps & { children: ReactNode }) {
  const { appName } = usePage().props
  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex flex-col p-6 md:p-10">
        <Link href="/" className="flex items-center gap-2 font-medium text-sm">
          <AppLogoIcon className="size-7" />
          {appName}
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
      <div className="relative hidden overflow-hidden bg-zinc-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_100%_0%,rgb(0_108_255/0.45),transparent_60%)]" />
        <AppPreview />
      </div>
    </div>
  )
}

/** A sketch of the app (header, tabs, cards), fading off the panel's edge. */
function AppPreview() {
  return (
    <div className="absolute top-[18%] left-[12%] w-[880px] rounded-xl border border-white/10 bg-white p-1 shadow-2xl dark:bg-zinc-900" aria-hidden="true">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-5 rounded-md bg-zinc-950 dark:bg-white" />
        <div className="h-2.5 w-24 rounded-full bg-zinc-200 dark:bg-zinc-700" />
        <div className="ms-auto size-6 rounded-full bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <div className="flex gap-5 px-4 pb-2">
        {[16, 20, 14, 18].map((width, index) => (
          <div key={index} className={`h-2 rounded-full ${index === 0 ? 'bg-zinc-900 dark:bg-zinc-200' : 'bg-zinc-200 dark:bg-zinc-700'}`} style={{ width: width * 4 }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-5 dark:border-white/10 dark:bg-zinc-950">
        {[0, 1, 2].map((card) => (
          <div key={card} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
            <div className="h-2.5 w-20 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-2">
                <div className="h-2 w-16 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                <div className="ms-auto size-1.5 rounded-full bg-emerald-500" />
                <div className="h-2 w-10 rounded-full bg-emerald-200 dark:bg-emerald-900" />
              </div>
            ))}
          </div>
        ))}
        <div className="col-span-3 space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <div className="size-3 rounded-full bg-emerald-500" />
              <div className="h-2 w-14 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              <div className="h-2 w-48 rounded-full bg-zinc-200 dark:bg-zinc-700" />
              <div className="ms-auto h-2 w-32 rounded-full bg-zinc-200 dark:bg-zinc-700" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

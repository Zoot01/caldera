import { usePage } from '@inertiajs/react'
import { AppLogoIcon } from '@/components/app-logo-icon'

export function AppLogo() {
  const { appName } = usePage().props
  return (
    <>
      <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <AppLogoIcon className="size-5" />
      </div>
      <span className="ms-1 truncate font-semibold text-sm">{appName}</span>
    </>
  )
}

import { usePage } from '@inertiajs/react'
import { AppLogoIcon } from '@/components/app-logo-icon'

/** The logo in the header and sidebar: Caldera's mark until you put your own here. */
export function AppLogo() {
  const { appName } = usePage().props
  return (
    <>
      <AppLogoIcon className="size-[26px] shrink-0" />
      <span className="sr-only">{appName}</span>
    </>
  )
}

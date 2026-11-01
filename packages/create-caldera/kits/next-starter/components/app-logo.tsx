'use client'

import { AppLogoIcon } from '@/components/app-logo-icon'
import { useShared } from '@/components/shared'

/** The logo in the header and sidebar: Caldera's mark until you put your own here. */
export function AppLogo() {
  const { appName } = useShared()
  return (
    <>
      <AppLogoIcon className="size-[26px] shrink-0" />
      <span className="sr-only">{appName}</span>
    </>
  )
}

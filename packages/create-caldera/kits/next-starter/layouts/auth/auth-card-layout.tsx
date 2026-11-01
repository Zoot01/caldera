import Link from 'next/link'
import type { ReactNode } from 'react'
import { AppLogoIcon } from '@/components/app-logo-icon'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import type { LayoutProps } from '@/types'

/** An auth layout with the form in a card on a muted background. Use it from layouts/auth-layout.tsx. */
export default function AuthCardLayout({ title, description, children }: LayoutProps & { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <Link href="/" className="flex items-center gap-2 self-center font-medium">
          <AppLogoIcon className="size-9" />
        </Link>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardPanel>{children}</CardPanel>
        </Card>
      </div>
    </div>
  )
}

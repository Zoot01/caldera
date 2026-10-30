import { useT } from '@caldera/i18n/react'
import { Head, Link, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppLogoIcon } from '@/components/app-logo-icon'
import { AppearanceTabs } from '@/components/appearance-tabs'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'

// The messages this page gets, in the visitor's locale (only these ship to the browser).
export const messages = ['home.*']

const code = (chunks: ReactNode[]) => <code className="rounded-sm bg-muted px-1 py-0.5 text-[0.9em]">{chunks}</code>

export default function Home({ message }: { message: string }) {
  const { appName, auth } = usePage().props
  const { t, rich } = useT()
  return (
    <>
      <Head title={t('home.title')} />
      <header className="flex items-center justify-between gap-4 p-4">
        <AppearanceTabs />
        <nav className="flex items-center gap-2">
          {auth.user ? (
            <Button variant="outline" render={<Link href="/dashboard" />}>
              Dashboard
            </Button>
          ) : (
            <>
              <Button variant="ghost" render={<Link href="/login" />}>
                Log in
              </Button>
              <Button variant="outline" render={<Link href="/register" />}>
                Register
              </Button>
            </>
          )}
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 pb-24">
        <Card>
          <CardHeader>
            <AppLogoIcon className="mb-2 size-9" />
            <CardTitle className="text-2xl">{appName}</CardTitle>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-3 text-muted-foreground text-sm">
            <p>{rich('home.edit', { code })}</p>
            <p>{rich('home.next', { code })}</p>
            <p>{rich('home.ui', { code })}</p>
          </CardPanel>
          <CardFooter>
            <Button render={<Link href={auth.user ? '/dashboard' : '/register'} />}>{auth.user ? 'Go to your dashboard' : 'Create an account'}</Button>
          </CardFooter>
        </Card>
      </main>
    </>
  )
}

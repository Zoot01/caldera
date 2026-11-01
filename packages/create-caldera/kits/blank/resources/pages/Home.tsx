import { useT } from '@caldera-js/i18n/react'
import { Head, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'
import { AppearanceTabs } from '@/components/appearance-tabs'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'

// The messages this page gets, in the visitor's locale (only these ship to the browser).
export const messages = ['home.*']

const code = (chunks: ReactNode[]) => <code className="rounded-sm bg-muted px-1 py-0.5 text-[0.9em]">{chunks}</code>

export default function Home({ message }: { message: string }) {
  const { appName } = usePage().props
  const { t, rich } = useT()
  return (
    <>
      <Head title={t('home.title')} />
      <header className="flex justify-end p-4">
        <AppearanceTabs />
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 pb-24">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{appName}</CardTitle>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-3 text-muted-foreground text-sm">
            <p>{rich('home.edit', { code })}</p>
            <p>{rich('home.next', { code })}</p>
            <p>{rich('home.ui', { code })}</p>
          </CardPanel>
        </Card>
      </main>
    </>
  )
}

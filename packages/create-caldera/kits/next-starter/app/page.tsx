import { createClientTranslator } from '@caldera-js/i18n/translator'
import { ArrowUpRight } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { AppearanceTabs } from '@/components/appearance-tabs'
import { Button } from '@/components/ui/button'
import { WelcomeArt } from '@/components/welcome-art'
import { context } from '@/lib/caldera'

export const metadata: Metadata = { title: 'Welcome' }

const code = (chunks: ReactNode[]) => <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em]">{chunks}</code>
const docs = (chunks: ReactNode[]) => (
  <a href="https://calderajs.dev/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-link underline underline-offset-4">
    {chunks}
    <ArrowUpRight className="size-3.5" />
  </a>
)

/** The welcome page: where to start, and a way in. */
export default async function Home() {
  const { user, i18n } = await context()
  // The visitor's language, with `rich` for the messages with tags (lang/en/home.json).
  const { t, rich } = createClientTranslator({ locale: i18n.locale, messages: i18n.messages(['home.*']) })
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex w-full items-center gap-2 p-4">
        <div className="me-auto">
          <AppearanceTabs />
        </div>
        {user ? (
          <Button variant="outline" render={<Link href="/dashboard" />}>
            {t('home.dashboard')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" render={<Link href="/login" />}>
              {t('home.login')}
            </Button>
            <Button variant="outline" render={<Link href="/register" />}>
              {t('home.signup')}
            </Button>
          </>
        )}
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="grid w-full max-w-4xl overflow-hidden rounded-xl border bg-card shadow-xs md:grid-cols-2">
          <div className="order-2 flex flex-col justify-center gap-6 p-8 md:order-1 md:p-12">
            <div className="space-y-2">
              <h1 className="font-medium">{t('home.start')}</h1>
              <p className="text-muted-foreground text-sm">{t('home.intro')}</p>
            </div>
            <ol className="relative space-y-4 text-sm before:absolute before:top-3 before:bottom-3 before:left-[7px] before:w-px before:bg-border">
              <Step>{rich('home.docs', { link: docs })}</Step>
              <Step>{rich('home.edit', { code })}</Step>
            </ol>
            <div>
              <Button render={<Link href={user ? '/dashboard' : '/register'} />}>{user ? t('home.dashboard') : t('home.register')}</Button>
            </div>
          </div>
          <WelcomeArt className="order-1 aspect-[12/11] w-full md:order-2 md:aspect-auto md:h-full" />
        </div>
      </main>
    </div>
  )
}

/** One suggestion, with a dot on the line joining them. */
function Step({ children }: { children: ReactNode }) {
  return (
    <li className="relative flex items-center gap-3">
      <span className="relative flex size-[15px] shrink-0 items-center justify-center rounded-full border bg-card">
        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
      </span>
      <span>{children}</span>
    </li>
  )
}

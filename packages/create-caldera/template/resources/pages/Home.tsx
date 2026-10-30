import { useT } from '@caldera/i18n/react'
import { Head, usePage } from '@inertiajs/react'
import type { ReactNode } from 'react'

// The messages this page gets, in the visitor's locale (only these ship to the browser).
export const messages = ['home.*']

const code = (chunks: ReactNode[]) => <code>{chunks}</code>

export default function Home({ message }: { message: string }) {
  const { appName } = usePage().props
  const { t, rich } = useT()
  return (
    <main>
      <Head title={t('home.title')} />
      <h1>{appName}</h1>
      <p>
        {message} {rich('home.edit', { code })}
      </p>
      <p>{rich('home.next', { code })}</p>
    </main>
  )
}
